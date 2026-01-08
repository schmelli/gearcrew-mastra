/**
 * Shared type definitions and Zod schemas for the Graph Gardening System
 * Based on data-model.md specifications
 */

import { z } from 'zod';

// ============================================================================
// Enums
// ============================================================================

export const IssueTypeSchema = z.enum([
  'orphan',
  'duplicate',
  'missing_data',
  'schema_violation',
  'supernode',
]);
export type IssueType = z.infer<typeof IssueTypeSchema>;

export const SeveritySchema = z.enum(['low', 'medium', 'high', 'critical']);
export type Severity = z.infer<typeof SeveritySchema>;

export const IssueStatusSchema = z.enum(['open', 'pending_approval', 'resolved', 'ignored']);
export type IssueStatus = z.infer<typeof IssueStatusSchema>;

export const ApprovalStatusSchema = z.enum(['pending', 'approved', 'rejected']);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const ProposedActionSchema = z.enum([
  'merge',
  'delete',
  'enrich',
  'reassign_brand',
  'change_category',
]);
export type ProposedAction = z.infer<typeof ProposedActionSchema>;

export const WorkflowTypeSchema = z.enum([
  'morning-hygiene',
  'deep-deduplication',
  'gap-filling',
  'manual',
]);
export type WorkflowType = z.infer<typeof WorkflowTypeSchema>;

export const WorkflowStatusSchema = z.enum(['running', 'suspended', 'completed', 'failed']);
export type WorkflowStatus = z.infer<typeof WorkflowStatusSchema>;

export const TriggerTypeSchema = z.enum(['schedule', 'manual', 'event']);
export type TriggerType = z.infer<typeof TriggerTypeSchema>;

export const AuditActionSchema = z.enum([
  'create',
  'update',
  'delete',
  'merge',
  'skip',
  'flag',
  'error',
]);
export type AuditAction = z.infer<typeof AuditActionSchema>;

export const CorrectionRuleTypeSchema = z.enum([
  'no_merge',
  'no_delete',
  'trusted_source',
  'pattern_exception',
]);
export type CorrectionRuleType = z.infer<typeof CorrectionRuleTypeSchema>;

export const RelationshipDirectionSchema = z.enum(['incoming', 'outgoing']);
export type RelationshipDirection = z.infer<typeof RelationshipDirectionSchema>;

// ============================================================================
// Node Relationship Schema
// ============================================================================

export const NodeRelationshipSchema = z.object({
  type: z.string(),
  direction: RelationshipDirectionSchema,
  targetId: z.string(),
  targetName: z.string(),
});
export type NodeRelationship = z.infer<typeof NodeRelationshipSchema>;

// ============================================================================
// Node Candidate Schema (for approval requests)
// ============================================================================

export const NodeCandidateSchema = z.object({
  nodeId: z.string(),
  nodeName: z.string(),
  nodeProperties: z.record(z.unknown()),
  relationships: z.array(NodeRelationshipSchema),
});
export type NodeCandidate = z.infer<typeof NodeCandidateSchema>;

// ============================================================================
// GardeningIssue Schema
// ============================================================================

export const GardeningIssueSchema = z.object({
  id: z.string().uuid(),
  type: IssueTypeSchema,
  severity: SeveritySchema,
  entities: z.array(z.string()),
  suggestedAction: z.string(),
  confidence: z.number().min(0).max(1),
  status: IssueStatusSchema,
  detectedAt: z.string().datetime(),
  workflowRunId: z.string().uuid(),
  graphContext: z.record(z.unknown()).optional(),
});
export type GardeningIssue = z.infer<typeof GardeningIssueSchema>;

// ============================================================================
// ApprovalResolution Schema
// ============================================================================

export const ApprovalResolutionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  notes: z.string().optional(),
  propertyResolutions: z.record(z.unknown()).optional(),
});
export type ApprovalResolution = z.infer<typeof ApprovalResolutionSchema>;

// ============================================================================
// ApprovalRequest Schema
// ============================================================================

export const ApprovalRequestSchema = z.object({
  id: z.string().uuid(),
  workflowRunId: z.string().uuid(),
  stepId: z.string(),
  issueId: z.string().uuid(),
  proposedAction: ProposedActionSchema,
  candidates: z.array(NodeCandidateSchema),
  reasoning: z.string(),
  confidence: z.number().min(0).max(1),
  createdAt: z.string().datetime(),
  status: ApprovalStatusSchema,
  resolvedAt: z.string().datetime().optional(),
  resolvedBy: z.string().optional(),
  resolution: ApprovalResolutionSchema.optional(),
  conflictingProperties: z.array(z.string()).optional(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

// ============================================================================
// CorrectionRule Pattern Schema
// ============================================================================

export const CorrectionRulePatternSchema = z.object({
  entityIds: z.array(z.string()).optional(),
  namePattern: z.string().optional(),
  categoryScope: z.string().optional(),
  brandScope: z.string().optional(),
});
export type CorrectionRulePattern = z.infer<typeof CorrectionRulePatternSchema>;

// ============================================================================
// CorrectionRule Schema
// ============================================================================

export const CorrectionRuleSchema = z.object({
  id: z.string().uuid(),
  ruleType: CorrectionRuleTypeSchema,
  pattern: CorrectionRulePatternSchema,
  description: z.string(),
  sourceDecisionId: z.string().uuid(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
  active: z.boolean().default(true),
});
export type CorrectionRule = z.infer<typeof CorrectionRuleSchema>;

// ============================================================================
// AuditEntry Schema
// ============================================================================

export const AuditEntrySchema = z.object({
  id: z.string().uuid(),
  timestamp: z.string().datetime(),
  workflowRunId: z.string(), // Accepts any string format (UUID or custom run IDs)
  workflowType: WorkflowTypeSchema,
  action: AuditActionSchema,
  entityId: z.string(),
  entityType: z.string(),
  before: z.record(z.unknown()).nullable(),
  after: z.record(z.unknown()).nullable(),
  // Core metadata fields
  confidence: z.number().min(0).max(1).optional(),
  reasoning: z.string().optional(),
  issueId: z.string().uuid().optional(),
  approvalId: z.string().uuid().optional(),
  // Extended metadata for specific actions
  autoMerge: z.boolean().optional(),
  humanApproved: z.boolean().optional(),
  primaryNodeId: z.string().optional(),
  secondaryNodeId: z.string().optional(),
  fieldsFilled: z.array(z.string()).optional(),
  source: z.string().optional(),
  sourceUrl: z.string().optional(),
  correctionRuleId: z.string().optional(),
  afterState: z.record(z.unknown()).optional(),
  metadata: z.record(z.unknown()).optional(),
}).passthrough(); // Allow additional properties

export type AuditEntry = z.infer<typeof AuditEntrySchema>;

// ============================================================================
// WorkflowStatistics Schema
// ============================================================================

export const WorkflowStatisticsSchema = z.object({
  itemsProcessed: z.number().default(0),
  issuesDetected: z.number().default(0),
  autoFixed: z.number().default(0),
  flaggedForReview: z.number().default(0),
  errors: z.number().default(0),
});
export type WorkflowStatistics = z.infer<typeof WorkflowStatisticsSchema>;

// ============================================================================
// SuspendedStep Schema
// ============================================================================

export const SuspendedStepSchema = z.object({
  stepId: z.string(),
  approvalId: z.string().uuid(),
  suspendedAt: z.string().datetime(),
});
export type SuspendedStep = z.infer<typeof SuspendedStepSchema>;

// ============================================================================
// WorkflowError Schema
// ============================================================================

export const WorkflowErrorSchema = z.object({
  message: z.string(),
  stack: z.string().optional(),
});
export type WorkflowError = z.infer<typeof WorkflowErrorSchema>;

// ============================================================================
// WorkflowRun Schema
// ============================================================================

export const WorkflowRunSchema = z.object({
  id: z.string().uuid(),
  workflowType: WorkflowTypeSchema,
  triggeredBy: TriggerTypeSchema,
  triggeredAt: z.string().datetime(),
  status: WorkflowStatusSchema,
  completedAt: z.string().datetime().optional(),
  statistics: WorkflowStatisticsSchema,
  suspendedSteps: z.array(SuspendedStepSchema).optional(),
  error: WorkflowErrorSchema.optional(),
});
export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;

// ============================================================================
// SystemMetrics Schema
// ============================================================================

export const SystemMetricsSchema = z.object({
  timestamp: z.string().datetime(),
  workflows: z.object({
    completed: z.number(),
    failed: z.number(),
    suspended: z.number(),
  }),
  items: z.object({
    processed: z.number(),
    autoFixed: z.number(),
    flagged: z.number(),
  }),
  approvals: z.object({
    pending: z.number(),
    approved: z.number(),
    rejected: z.number(),
  }),
  errors: z.object({
    rate: z.number(),
    total: z.number(),
  }),
  uptime: z.number(),
});
export type SystemMetrics = z.infer<typeof SystemMetricsSchema>;

// ============================================================================
// Graph Entity Schemas (Memgraph)
// ============================================================================

export const GearItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  brand_id: z.string().optional(),
  category: z.string().optional(),
  weight_grams: z.number().int().min(1).max(50000).optional(),
  price_usd: z.number().optional(),
  embedding_vector: z.array(z.number()).optional(),
  completeness_score: z.number().min(0).max(1).optional(),
});
export type GearItem = z.infer<typeof GearItemSchema>;

export const OutdoorBrandSchema = z.object({
  id: z.string(),
  name: z.string(),
  website: z.string().url().optional(),
});
export type OutdoorBrand = z.infer<typeof OutdoorBrandSchema>;

// ============================================================================
// Orphan Classification
// ============================================================================

export const OrphanClassificationSchema = z.enum(['empty', 'generic', 'valuable', 'small_island', 'large_island']);
export type OrphanClassification = z.infer<typeof OrphanClassificationSchema>;

export const OrphanNodeSchema = z.object({
  nodeId: z.string(),
  componentId: z.number(),
  componentSize: z.number(),
  classification: OrphanClassificationSchema,
  properties: z.record(z.unknown()),
  hasValuableKeywords: z.boolean(),
});
export type OrphanNode = z.infer<typeof OrphanNodeSchema>;

// ============================================================================
// Duplicate Detection
// ============================================================================

export const DuplicateCandidateSchema = z.object({
  nodeA: NodeCandidateSchema,
  nodeB: NodeCandidateSchema,
  similarity: z.number().min(0).max(1),
  confidenceScore: z.number().min(0).max(1),
  conflictingProperties: z.array(z.string()).optional(),
});
export type DuplicateCandidate = z.infer<typeof DuplicateCandidateSchema>;

// ============================================================================
// API Request/Response Schemas
// ============================================================================

export const ChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ChatRequestSchema = z.object({
  messages: z.array(ChatMessageSchema),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export const ResumeRequestSchema = z.object({
  stepId: z.string(),
  decision: z.enum(['approve', 'reject']),
  notes: z.string().optional(),
  propertyResolutions: z.record(z.unknown()).optional(),
});
export type ResumeRequest = z.infer<typeof ResumeRequestSchema>;

export const TriggerWorkflowRequestSchema = z.object({
  workflowType: z.enum(['morning-hygiene', 'deep-deduplication', 'gap-filling']),
  scope: z
    .object({
      category: z.string().optional(),
      brandId: z.string().optional(),
    })
    .optional(),
});
export type TriggerWorkflowRequest = z.infer<typeof TriggerWorkflowRequestSchema>;

// ============================================================================
// Confidence Thresholds (from spec.md)
// ============================================================================

export const CONFIDENCE_THRESHOLDS = {
  AUTO_MERGE: 0.98,
  REQUIRE_APPROVAL: 0.80,
  SKIP: 0.80,
} as const;

// ============================================================================
// Valuable Keywords for Orphan Detection
// ============================================================================

export const VALUABLE_KEYWORDS = [
  // Brand names
  'osprey',
  'patagonia',
  'arc\'teryx',
  'rei',
  'msr',
  'big agnes',
  'nemo',
  'thermarest',
  'jetboil',
  'black diamond',
  'petzl',
  // Product types
  'backpack',
  'tent',
  'sleeping bag',
  'stove',
  'headlamp',
  'trekking poles',
  // Specifications
  'grams',
  'liters',
  'denier',
  'waterproof',
  'ultralight',
] as const;
