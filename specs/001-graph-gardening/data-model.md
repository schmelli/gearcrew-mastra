# Data Model: Autonomous Graph Gardening System

**Date**: 2026-01-07
**Feature**: 001-graph-gardening

## Overview

This document defines the data entities used by the Graph Gardening system. The system operates on two storage layers:

1. **Memgraph** - Existing graph database containing gear items, brands, and relationships
2. **LibSQL** - Workflow state, audit logs, memory, and correction rules

## Existing Graph Entities (Memgraph)

These entities pre-exist in the GearGraph database. The gardening system reads and modifies them but does not define their schema.

### GearItem

Represents a piece of outdoor gear in the knowledge graph.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| id | string | Yes | Unique identifier |
| name | string | Yes | Product name |
| brand_id | string | No | Reference to OutdoorBrand |
| category | string | No | Product category (backpack, tent, etc.) |
| weight_grams | integer | No | Weight in grams |
| price_usd | number | No | Price in USD |
| embedding_vector | float[] | No | Text embedding for similarity (768 dimensions) |
| completeness_score | number | No | 0.0-1.0 score of data completeness |

**Relationships**:
- `(:GearItem)-[:MANUFACTURED_BY]->(:OutdoorBrand)`
- `(:GearItem)-[:EXTRACTED_FROM]->(:VideoSource)`
- `(:GearItem)-[:SIMILAR_TO {similarity: float}]->(:GearItem)`

### OutdoorBrand

Represents a gear manufacturer.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| id | string | Yes | Unique identifier |
| name | string | Yes | Brand name (canonical form) |
| website | string | No | Official website URL |

**Relationships**:
- `(:OutdoorBrand)-[:MANUFACTURES]->(:GearItem)`

## Gardening System Entities (LibSQL)

These entities are owned and managed by the gardening system.

### GardeningIssue

A detected problem requiring action.

```typescript
const GardeningIssueSchema = z.object({
  id: z.string().uuid(),
  type: z.enum(['orphan', 'duplicate', 'missing_data', 'schema_violation', 'supernode']),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  entities: z.array(z.string()),  // Node IDs involved
  suggestedAction: z.string(),
  confidence: z.number().min(0).max(1),
  status: z.enum(['open', 'pending_approval', 'resolved', 'ignored']),
  detectedAt: z.string().datetime(),
  workflowRunId: z.string().uuid(),
  graphContext: z.record(z.unknown()).optional()
});
```

**Status Transitions**:
```
open → pending_approval (when confidence < threshold)
open → resolved (when auto-fixed)
pending_approval → resolved (when approved)
pending_approval → ignored (when rejected)
```

### ApprovalRequest

A suspended workflow decision awaiting human input.

```typescript
const ApprovalRequestSchema = z.object({
  id: z.string().uuid(),
  workflowRunId: z.string().uuid(),
  stepId: z.string(),
  issueId: z.string().uuid(),
  proposedAction: z.enum(['merge', 'delete', 'enrich', 'reassign_brand', 'change_category']),
  candidates: z.array(z.object({
    nodeId: z.string(),
    nodeName: z.string(),
    nodeProperties: z.record(z.unknown()),
    relationships: z.array(z.object({
      type: z.string(),
      direction: z.enum(['incoming', 'outgoing']),
      targetId: z.string(),
      targetName: z.string()
    }))
  })),
  reasoning: z.string(),
  confidence: z.number().min(0).max(1),
  createdAt: z.string().datetime(),
  status: z.enum(['pending', 'approved', 'rejected']),
  resolvedAt: z.string().datetime().optional(),
  resolvedBy: z.string().optional(),
  resolution: z.object({
    decision: z.enum(['approve', 'reject']),
    notes: z.string().optional(),
    propertyResolutions: z.record(z.unknown()).optional()  // For conflict resolution
  }).optional()
});
```

**Retention**: Indefinite per clarification (never expire).

### CorrectionRule

A learned constraint from rejected actions.

```typescript
const CorrectionRuleSchema = z.object({
  id: z.string().uuid(),
  ruleType: z.enum(['no_merge', 'no_delete', 'trusted_source', 'pattern_exception']),
  pattern: z.object({
    entityIds: z.array(z.string()).optional(),      // Specific entities
    namePattern: z.string().optional(),              // Regex pattern
    categoryScope: z.string().optional(),            // Category filter
    brandScope: z.string().optional()                // Brand filter
  }),
  description: z.string(),                           // Human-readable explanation
  sourceDecisionId: z.string().uuid(),               // ApprovalRequest that created this
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),       // null = never expires
  active: z.boolean().default(true)
});
```

**Examples**:
```json
{
  "ruleType": "no_merge",
  "pattern": { "namePattern": ".* Pro$" },
  "description": "Do not merge Pro and Non-Pro product variants"
}
```

### AuditEntry

An immutable record of system actions.

```typescript
const AuditEntrySchema = z.object({
  id: z.string().uuid(),
  timestamp: z.string().datetime(),
  workflowRunId: z.string().uuid(),
  workflowType: z.enum(['morning-hygiene', 'deep-deduplication', 'gap-filling', 'manual']),
  action: z.enum(['create', 'update', 'delete', 'merge', 'skip', 'flag', 'error']),
  entityId: z.string(),
  entityType: z.string(),
  before: z.record(z.unknown()).nullable(),
  after: z.record(z.unknown()).nullable(),
  confidence: z.number().min(0).max(1).optional(),
  reasoning: z.string().optional(),
  issueId: z.string().uuid().optional(),
  approvalId: z.string().uuid().optional()
});
```

**Storage**: Append-only JSONL file (`/data/audit.jsonl`).
**Retention**: 1 year, then purge per FR-026a/b.

### WorkflowRun

An execution instance of a workflow.

```typescript
const WorkflowRunSchema = z.object({
  id: z.string().uuid(),
  workflowType: z.enum(['morning-hygiene', 'deep-deduplication', 'gap-filling', 'manual']),
  triggeredBy: z.enum(['schedule', 'manual', 'event']),
  triggeredAt: z.string().datetime(),
  status: z.enum(['running', 'suspended', 'completed', 'failed']),
  completedAt: z.string().datetime().optional(),
  statistics: z.object({
    itemsProcessed: z.number().default(0),
    issuesDetected: z.number().default(0),
    autoFixed: z.number().default(0),
    flaggedForReview: z.number().default(0),
    errors: z.number().default(0)
  }),
  suspendedSteps: z.array(z.object({
    stepId: z.string(),
    approvalId: z.string().uuid(),
    suspendedAt: z.string().datetime()
  })).optional(),
  error: z.object({
    message: z.string(),
    stack: z.string().optional()
  }).optional()
});
```

### SystemMetrics

Prometheus-compatible metrics snapshot.

```typescript
const SystemMetricsSchema = z.object({
  timestamp: z.string().datetime(),
  workflows: z.object({
    completed: z.number(),
    failed: z.number(),
    suspended: z.number()
  }),
  items: z.object({
    processed: z.number(),
    autoFixed: z.number(),
    flagged: z.number()
  }),
  approvals: z.object({
    pending: z.number(),
    approved: z.number(),
    rejected: z.number()
  }),
  errors: z.object({
    rate: z.number(),        // Percentage in last 5 minutes
    total: z.number()
  }),
  uptime: z.number()         // Seconds since start
});
```

## Entity Relationships

```
┌─────────────────────────────────────────────────────────────────┐
│                         Memgraph                                 │
│  ┌─────────────┐         ┌──────────────┐                       │
│  │  GearItem   │────────▶│ OutdoorBrand │                       │
│  │             │◀────────│              │                       │
│  └─────────────┘         └──────────────┘                       │
│         │                                                        │
│         │ SIMILAR_TO                                            │
│         ▼                                                        │
│  ┌─────────────┐                                                │
│  │  GearItem   │                                                │
│  └─────────────┘                                                │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ referenced by
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                          LibSQL                                  │
│  ┌─────────────────┐      ┌───────────────────┐                 │
│  │ GardeningIssue  │─────▶│  ApprovalRequest  │                 │
│  └─────────────────┘      └───────────────────┘                 │
│         │                          │                             │
│         │                          │ creates                     │
│         │                          ▼                             │
│         │                 ┌───────────────────┐                 │
│         │                 │  CorrectionRule   │                 │
│         │                 └───────────────────┘                 │
│         │                                                        │
│         │ logged to                                             │
│         ▼                                                        │
│  ┌─────────────────┐      ┌───────────────────┐                 │
│  │   AuditEntry    │      │   WorkflowRun     │                 │
│  └─────────────────┘      └───────────────────┘                 │
└─────────────────────────────────────────────────────────────────┘
```

## Validation Rules

### GearItem Constraints (enforced by gardening)

| Rule | Violation Type | Action |
|------|----------------|--------|
| name must not have leading/trailing whitespace | schema_violation | Auto-fix |
| weight_grams must be 1-50000 | schema_violation | Flag for review |
| brand_id should reference existing brand | missing_data | Queue for enrichment |
| embedding_vector should exist | missing_data | Exclude from similarity |

### Merge Conflict Resolution

When merging duplicates with conflicting properties:

1. **Non-null wins over null**: If one node has a value and other is null, use the value
2. **Same type, different value**: Flag for human resolution
3. **Relationships**: Transfer all from absorbed node to survivor
4. **Audit**: Record both before states, resulting after state

### Orphan Classification

| Condition | Classification | Action |
|-----------|----------------|--------|
| Size=1, no properties | Empty orphan | Auto-delete |
| Size=1, generic content only | Generic orphan | Auto-delete |
| Size=1, has brand/product keywords | Valuable orphan | Queue for resolution |
| Size 2-3 | Small island | Flag for review |
| Size 4+ | Large island | Flag for human review |
