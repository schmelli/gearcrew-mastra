/**
 * Phase 7: Unified Learning System
 *
 * Implements continuous learning from human feedback through:
 * 1. Correction rules (from rejections)
 * 2. Confidence calibration (dynamic threshold adjustment)
 * 3. Episodic memory (past decisions for context)
 * 4. Semantic patterns (learned conventions)
 */

import { v4 as uuidv4 } from 'uuid';
import { createClient } from '@libsql/client';
import { getCorrectionRulesManager, type CorrectionRule } from './correction-rules';
import type { CurationRequest } from '../../types';

// Direct LibSQL client to avoid circular import with mastra/index
let libsqlClient: ReturnType<typeof createClient> | null = null;
function getLibSQLClient(): ReturnType<typeof createClient> {
  if (!libsqlClient) {
    libsqlClient = createClient({
      url: process.env.LIBSQL_URL ?? 'file:/data/memory.db',
    });
  }
  return libsqlClient;
}

// ============================================================================
// Constants
// ============================================================================

const CONFIDENCE_THRESHOLDS = {
  AUTO_APPROVE: 0.95,
  REQUIRE_APPROVAL: 0.85,
  AUTO_REJECT: 0.3,
} as const;

const CALIBRATION_ALPHA = 0.1; // Exponential moving average weight
const MIN_SAMPLE_SIZE = 10; // Minimum samples before using calibrated threshold

// ============================================================================
// Types
// ============================================================================

export interface ConfidenceCalibration {
  id: string;
  agentId: string;
  actionType: string;
  historicalAccuracy: number;
  sampleSize: number;
  adjustedThreshold: number;
  lastUpdated: string;
}

export interface EpisodicMemoryRecord {
  id: string;
  timestamp: string;
  entityId: string;
  entityName: string;
  actionType: string;
  decision: 'auto_approved' | 'human_approved' | 'human_rejected' | 'skipped';
  workflowRunId?: string;
  confidence?: number;
  reasoning?: string;
  outcomeSuccessful?: boolean;
  outcomeNotes?: string;
  metadata?: Record<string, unknown>;
}

export interface SemanticPattern {
  id: string;
  patternType: 'brand_convention' | 'category_default' | 'naming_pattern' | 'relationship_rule' | 'field_inference';
  conditionField: string;
  conditionValue: string;
  inferenceField: string;
  inferenceValue: string;
  confidence: number;
  supportingEvidence: number;
  createdAt: string;
  updatedAt: string;
}

export interface DecisionResult {
  blocked?: boolean;
  requiresApproval?: boolean;
  autoApproved?: boolean;
  confidence: number;
  reason?: string;
  ruleId?: string;
  patterns?: SemanticPattern[];
  pastDecisions?: EpisodicMemoryRecord[];
}

export interface ApprovalDecision {
  id: string;
  entityId: string;
  entityName: string;
  actionType: string;
  similarity?: number;
  conflictingProperties?: string[];
  brand?: string;
  category?: string;
  userNotes?: string;
  approved: boolean;
  workflowRunId?: string;
}

// ============================================================================
// Confidence Calibration
// ============================================================================

/**
 * Get or create calibration for an agent/action pair
 */
async function getCalibration(
  agentId: string,
  actionType: string
): Promise<ConfidenceCalibration> {
  const db = getLibSQLClient();

  const result = await db.execute({
    sql: `SELECT * FROM confidence_calibration WHERE agent_id = ? AND action_type = ?`,
    args: [agentId, actionType],
  });

  if (result.rows.length > 0) {
    const row = result.rows[0];
    return {
      id: row!.id as string,
      agentId: row!.agent_id as string,
      actionType: row!.action_type as string,
      historicalAccuracy: row!.historical_accuracy as number,
      sampleSize: row!.sample_size as number,
      adjustedThreshold: row!.adjusted_threshold as number,
      lastUpdated: row!.last_updated as string,
    };
  }

  // Create new calibration with defaults
  const now = new Date().toISOString();
  const newCalibration: ConfidenceCalibration = {
    id: uuidv4(),
    agentId,
    actionType,
    historicalAccuracy: 0.5,
    sampleSize: 0,
    adjustedThreshold: CONFIDENCE_THRESHOLDS.REQUIRE_APPROVAL,
    lastUpdated: now,
  };

  await db.execute({
    sql: `INSERT INTO confidence_calibration
          (id, agent_id, action_type, historical_accuracy, sample_size, adjusted_threshold, last_updated)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      newCalibration.id,
      newCalibration.agentId,
      newCalibration.actionType,
      newCalibration.historicalAccuracy,
      newCalibration.sampleSize,
      newCalibration.adjustedThreshold,
      newCalibration.lastUpdated,
    ],
  });

  return newCalibration;
}

/**
 * Update confidence calibration based on human feedback
 */
export async function updateConfidenceCalibration(
  agentId: string,
  actionType: string,
  wasApproved: boolean
): Promise<void> {
  const db = getLibSQLClient();
  const calibration = await getCalibration(agentId, actionType);

  // Exponential moving average update
  calibration.historicalAccuracy =
    CALIBRATION_ALPHA * (wasApproved ? 1 : 0) +
    (1 - CALIBRATION_ALPHA) * calibration.historicalAccuracy;
  calibration.sampleSize++;

  // Adjust threshold: if accuracy low, require higher confidence
  // Formula: base_threshold + (1 - accuracy) * 0.15
  calibration.adjustedThreshold = Math.min(
    0.98,
    CONFIDENCE_THRESHOLDS.REQUIRE_APPROVAL + (1 - calibration.historicalAccuracy) * 0.15
  );
  calibration.lastUpdated = new Date().toISOString();

  await db.execute({
    sql: `UPDATE confidence_calibration
          SET historical_accuracy = ?, sample_size = ?, adjusted_threshold = ?, last_updated = ?
          WHERE id = ?`,
    args: [
      calibration.historicalAccuracy,
      calibration.sampleSize,
      calibration.adjustedThreshold,
      calibration.lastUpdated,
      calibration.id,
    ],
  });
}

/**
 * Determine if an action should be auto-approved based on calibrated threshold
 */
export async function shouldAutoApprove(
  agentId: string,
  actionType: string,
  confidence: number
): Promise<boolean> {
  const calibration = await getCalibration(agentId, actionType);

  // Need minimum sample size before using calibrated threshold
  if (calibration.sampleSize < MIN_SAMPLE_SIZE) {
    return confidence >= CONFIDENCE_THRESHOLDS.AUTO_APPROVE;
  }

  return confidence >= calibration.adjustedThreshold;
}

/**
 * Get all calibrations for reporting
 */
export async function getAllCalibrations(): Promise<ConfidenceCalibration[]> {
  const db = getLibSQLClient();

  const result = await db.execute({
    sql: `SELECT * FROM confidence_calibration ORDER BY agent_id, action_type`,
    args: [],
  });

  return result.rows.map((row) => ({
    id: row!.id as string,
    agentId: row!.agent_id as string,
    actionType: row!.action_type as string,
    historicalAccuracy: row!.historical_accuracy as number,
    sampleSize: row!.sample_size as number,
    adjustedThreshold: row!.adjusted_threshold as number,
    lastUpdated: row!.last_updated as string,
  }));
}

// ============================================================================
// Episodic Memory
// ============================================================================

/**
 * Record a decision in episodic memory
 */
export async function recordEpisodicMemory(
  record: Omit<EpisodicMemoryRecord, 'id' | 'timestamp'>
): Promise<string> {
  const db = getLibSQLClient();
  const id = uuidv4();
  const timestamp = new Date().toISOString();

  await db.execute({
    sql: `INSERT INTO episodic_memory
          (id, timestamp, entity_id, entity_name, action_type, decision, workflow_run_id,
           confidence, reasoning, outcome_successful, outcome_notes, metadata)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      timestamp,
      record.entityId,
      record.entityName,
      record.actionType,
      record.decision,
      record.workflowRunId || null,
      record.confidence || null,
      record.reasoning || null,
      record.outcomeSuccessful !== undefined ? (record.outcomeSuccessful ? 1 : 0) : null,
      record.outcomeNotes || null,
      JSON.stringify(record.metadata || {}),
    ],
  });

  return id;
}

/**
 * Recall similar decisions from episodic memory
 */
export async function recallSimilarDecisions(
  entityName: string,
  actionType: string,
  limit: number = 5
): Promise<EpisodicMemoryRecord[]> {
  const db = getLibSQLClient();

  // Extract first word for fuzzy matching
  const firstWord = entityName.split(' ')[0] || '';

  const result = await db.execute({
    sql: `SELECT * FROM episodic_memory
          WHERE action_type = ?
          AND entity_name LIKE ?
          ORDER BY timestamp DESC
          LIMIT ?`,
    args: [actionType, `%${firstWord}%`, limit],
  });

  return result.rows.map((row) => ({
    id: row!.id as string,
    timestamp: row!.timestamp as string,
    entityId: row!.entity_id as string,
    entityName: row!.entity_name as string,
    actionType: row!.action_type as string,
    decision: row!.decision as EpisodicMemoryRecord['decision'],
    workflowRunId: row!.workflow_run_id as string | undefined,
    confidence: row!.confidence as number | undefined,
    reasoning: row!.reasoning as string | undefined,
    outcomeSuccessful: row!.outcome_successful === 1,
    outcomeNotes: row!.outcome_notes as string | undefined,
    metadata: JSON.parse((row!.metadata as string) || '{}'),
  }));
}

/**
 * Get recent decisions for an entity
 */
export async function getEntityDecisionHistory(
  entityId: string,
  limit: number = 10
): Promise<EpisodicMemoryRecord[]> {
  const db = getLibSQLClient();

  const result = await db.execute({
    sql: `SELECT * FROM episodic_memory
          WHERE entity_id = ?
          ORDER BY timestamp DESC
          LIMIT ?`,
    args: [entityId, limit],
  });

  return result.rows.map((row) => ({
    id: row!.id as string,
    timestamp: row!.timestamp as string,
    entityId: row!.entity_id as string,
    entityName: row!.entity_name as string,
    actionType: row!.action_type as string,
    decision: row!.decision as EpisodicMemoryRecord['decision'],
    workflowRunId: row!.workflow_run_id as string | undefined,
    confidence: row!.confidence as number | undefined,
    reasoning: row!.reasoning as string | undefined,
    outcomeSuccessful: row!.outcome_successful === 1,
    outcomeNotes: row!.outcome_notes as string | undefined,
    metadata: JSON.parse((row!.metadata as string) || '{}'),
  }));
}

// ============================================================================
// Semantic Patterns
// ============================================================================

/**
 * Find or create a semantic pattern
 */
export async function findOrCreatePattern(
  patternType: SemanticPattern['patternType'],
  conditionField: string,
  conditionValue: string,
  inferenceField: string,
  inferenceValue: string
): Promise<SemanticPattern> {
  const db = getLibSQLClient();

  const result = await db.execute({
    sql: `SELECT * FROM semantic_patterns
          WHERE pattern_type = ? AND condition_field = ? AND condition_value = ?
          AND inference_field = ? AND inference_value = ?`,
    args: [patternType, conditionField, conditionValue, inferenceField, inferenceValue],
  });

  if (result.rows.length > 0) {
    const row = result.rows[0];
    return {
      id: row!.id as string,
      patternType: row!.pattern_type as SemanticPattern['patternType'],
      conditionField: row!.condition_field as string,
      conditionValue: row!.condition_value as string,
      inferenceField: row!.inference_field as string,
      inferenceValue: row!.inference_value as string,
      confidence: row!.confidence as number,
      supportingEvidence: row!.supporting_evidence as number,
      createdAt: row!.created_at as string,
      updatedAt: row!.updated_at as string,
    };
  }

  // Create new pattern
  const now = new Date().toISOString();
  const newPattern: SemanticPattern = {
    id: uuidv4(),
    patternType,
    conditionField,
    conditionValue,
    inferenceField,
    inferenceValue,
    confidence: 0.5,
    supportingEvidence: 1,
    createdAt: now,
    updatedAt: now,
  };

  await db.execute({
    sql: `INSERT INTO semantic_patterns
          (id, pattern_type, condition_field, condition_value, inference_field, inference_value,
           confidence, supporting_evidence, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      newPattern.id,
      newPattern.patternType,
      newPattern.conditionField,
      newPattern.conditionValue,
      newPattern.inferenceField,
      newPattern.inferenceValue,
      newPattern.confidence,
      newPattern.supportingEvidence,
      newPattern.createdAt,
      newPattern.updatedAt,
    ],
  });

  return newPattern;
}

/**
 * Learn a pattern from successful operations
 */
export async function learnPattern(
  patternType: SemanticPattern['patternType'],
  conditionField: string,
  conditionValue: string,
  inferenceField: string,
  inferenceValue: string
): Promise<SemanticPattern> {
  const db = getLibSQLClient();

  // Check if pattern exists
  const result = await db.execute({
    sql: `SELECT * FROM semantic_patterns
          WHERE pattern_type = ? AND condition_field = ? AND condition_value = ?
          AND inference_field = ? AND inference_value = ?`,
    args: [patternType, conditionField, conditionValue, inferenceField, inferenceValue],
  });

  if (result.rows.length > 0) {
    const row = result.rows[0];
    const existing: SemanticPattern = {
      id: row!.id as string,
      patternType: row!.pattern_type as SemanticPattern['patternType'],
      conditionField: row!.condition_field as string,
      conditionValue: row!.condition_value as string,
      inferenceField: row!.inference_field as string,
      inferenceValue: row!.inference_value as string,
      confidence: row!.confidence as number,
      supportingEvidence: row!.supporting_evidence as number,
      createdAt: row!.created_at as string,
      updatedAt: row!.updated_at as string,
    };

    // Strengthen existing pattern
    existing.supportingEvidence++;
    existing.confidence = Math.min(0.99, existing.confidence + 0.01);
    existing.updatedAt = new Date().toISOString();

    await db.execute({
      sql: `UPDATE semantic_patterns
            SET supporting_evidence = ?, confidence = ?, updated_at = ?
            WHERE id = ?`,
      args: [existing.supportingEvidence, existing.confidence, existing.updatedAt, existing.id],
    });

    return existing;
  }

  // Create new pattern
  return findOrCreatePattern(patternType, conditionField, conditionValue, inferenceField, inferenceValue);
}

/**
 * Find relevant patterns for an entity
 */
export async function findRelevantPatterns(
  entity: { brand?: string; category?: string; name?: string }
): Promise<SemanticPattern[]> {
  const db = getLibSQLClient();
  const patterns: SemanticPattern[] = [];

  // Find brand conventions
  if (entity.brand) {
    const brandResult = await db.execute({
      sql: `SELECT * FROM semantic_patterns
            WHERE condition_field = 'brand' AND condition_value = ?
            AND confidence >= 0.6
            ORDER BY confidence DESC`,
      args: [entity.brand.toLowerCase()],
    });

    for (const row of brandResult.rows) {
      patterns.push({
        id: row!.id as string,
        patternType: row!.pattern_type as SemanticPattern['patternType'],
        conditionField: row!.condition_field as string,
        conditionValue: row!.condition_value as string,
        inferenceField: row!.inference_field as string,
        inferenceValue: row!.inference_value as string,
        confidence: row!.confidence as number,
        supportingEvidence: row!.supporting_evidence as number,
        createdAt: row!.created_at as string,
        updatedAt: row!.updated_at as string,
      });
    }
  }

  // Find category conventions
  if (entity.category) {
    const categoryResult = await db.execute({
      sql: `SELECT * FROM semantic_patterns
            WHERE condition_field = 'category' AND condition_value = ?
            AND confidence >= 0.6
            ORDER BY confidence DESC`,
      args: [entity.category.toLowerCase()],
    });

    for (const row of categoryResult.rows) {
      patterns.push({
        id: row!.id as string,
        patternType: row!.pattern_type as SemanticPattern['patternType'],
        conditionField: row!.condition_field as string,
        conditionValue: row!.condition_value as string,
        inferenceField: row!.inference_field as string,
        inferenceValue: row!.inference_value as string,
        confidence: row!.confidence as number,
        supportingEvidence: row!.supporting_evidence as number,
        createdAt: row!.created_at as string,
        updatedAt: row!.updated_at as string,
      });
    }
  }

  return patterns;
}

/**
 * Get all high-confidence patterns
 */
export async function getHighConfidencePatterns(
  minConfidence: number = 0.7
): Promise<SemanticPattern[]> {
  const db = getLibSQLClient();

  const result = await db.execute({
    sql: `SELECT * FROM semantic_patterns
          WHERE confidence >= ?
          ORDER BY confidence DESC, supporting_evidence DESC`,
    args: [minConfidence],
  });

  return result.rows.map((row) => ({
    id: row!.id as string,
    patternType: row!.pattern_type as SemanticPattern['patternType'],
    conditionField: row!.condition_field as string,
    conditionValue: row!.condition_value as string,
    inferenceField: row!.inference_field as string,
    inferenceValue: row!.inference_value as string,
    confidence: row!.confidence as number,
    supportingEvidence: row!.supporting_evidence as number,
    createdAt: row!.created_at as string,
    updatedAt: row!.updated_at as string,
  }));
}

// ============================================================================
// Unified Decision Making
// ============================================================================

/**
 * Make an informed decision by consulting all memory layers
 */
export async function makeInformedDecision(
  agentId: string,
  actionType: string,
  entityName: string,
  proposedAction: CurationRequest,
  confidence: number
): Promise<DecisionResult> {
  const rulesManager = getCorrectionRulesManager();

  // Extract entity info from proposed action
  const entity = {
    brand: proposedAction.data?.brand as string | undefined,
    category: proposedAction.data?.category as string | undefined,
    name: entityName,
  };

  // 1. Check correction rules (blocks)
  const blockingRule = await rulesManager.findBlockingRule(
    { type: actionType, nodeId: proposedAction.nodeId, data: proposedAction.data },
    entity
  );
  if (blockingRule) {
    return {
      blocked: true,
      confidence,
      reason: blockingRule.description || `Blocked by rule: ${blockingRule.name}`,
      ruleId: blockingRule.id,
    };
  }

  // 2. Recall similar past decisions
  const pastDecisions = await recallSimilarDecisions(entityName, actionType);
  const recentRejections = pastDecisions.filter((d) => d.decision === 'human_rejected');
  if (recentRejections.length >= 2) {
    return {
      requiresApproval: true,
      confidence,
      reason: 'Similar items recently rejected by human',
      pastDecisions,
    };
  }

  // 3. Check semantic patterns for guidance
  const patterns = await findRelevantPatterns(entity);

  // 4. Apply calibrated confidence threshold
  const shouldAuto = await shouldAutoApprove(agentId, actionType, confidence);

  if (shouldAuto) {
    return {
      autoApproved: true,
      confidence,
      patterns,
      pastDecisions,
    };
  }

  return {
    requiresApproval: true,
    confidence,
    patterns,
    pastDecisions,
    reason: 'Confidence below calibrated threshold',
  };
}

// ============================================================================
// Learning from Human Feedback
// ============================================================================

/**
 * Learn from a human approval decision
 */
export async function learnFromApproval(decision: ApprovalDecision): Promise<void> {
  const rulesManager = getCorrectionRulesManager();

  // 1. Update confidence calibration
  await updateConfidenceCalibration('curator', decision.actionType, decision.approved);

  // 2. Record in episodic memory
  await recordEpisodicMemory({
    entityId: decision.entityId,
    entityName: decision.entityName,
    actionType: decision.actionType,
    decision: decision.approved ? 'human_approved' : 'human_rejected',
    workflowRunId: decision.workflowRunId,
    reasoning: decision.userNotes,
  });

  // 3. Create correction rules from rejections
  if (!decision.approved) {
    if (decision.actionType === 'merge' && decision.similarity !== undefined) {
      // Create do-not-merge rule for rejected merges
      await rulesManager.createDoNotMergeRule(
        { id: decision.entityId, name: decision.entityName, brand: decision.brand, category: decision.category },
        { id: '', name: '', brand: decision.brand, category: decision.category },
        decision.similarity,
        decision.userNotes
      );
    }
  }

  // 4. Learn patterns from approvals
  if (decision.approved && decision.brand) {
    // Learn brand trust if consistently approved
    const pastBrandDecisions = await recallSimilarDecisions(decision.brand, decision.actionType, 10);
    const approvalRate =
      pastBrandDecisions.filter((d) => d.decision === 'human_approved' || d.decision === 'auto_approved').length /
      Math.max(1, pastBrandDecisions.length);

    if (approvalRate >= 0.8 && pastBrandDecisions.length >= 5) {
      await rulesManager.createBrandTrustRule(decision.brand, 'high', [], 'High approval rate');
    }
  }
}

/**
 * Learn from a successful operation (after execution)
 */
export async function learnFromSuccessfulOperation(
  entityId: string,
  entityName: string,
  actionType: string,
  entity: { brand?: string; category?: string },
  data: Record<string, unknown>
): Promise<void> {
  // Learn brand conventions
  if (entity.brand) {
    // Weight unit convention
    if (data.weightUnit) {
      await learnPattern(
        'brand_convention',
        'brand',
        entity.brand.toLowerCase(),
        'weight_unit',
        String(data.weightUnit)
      );
    }

    // Price currency convention
    if (data.priceCurrency) {
      await learnPattern(
        'brand_convention',
        'brand',
        entity.brand.toLowerCase(),
        'price_currency',
        String(data.priceCurrency)
      );
    }
  }

  // Learn category defaults
  if (entity.category) {
    // Common fields for category
    if (data.weight !== undefined) {
      await learnPattern('category_default', 'category', entity.category.toLowerCase(), 'has_weight', 'true');
    }

    if (data.waterproofRating) {
      await learnPattern(
        'category_default',
        'category',
        entity.category.toLowerCase(),
        'has_waterproof_rating',
        'true'
      );
    }
  }

  // Update episodic memory with successful outcome
  const history = await getEntityDecisionHistory(entityId, 1);
  if (history.length > 0) {
    const db = getLibSQLClient();
    await db.execute({
      sql: `UPDATE episodic_memory SET outcome_successful = 1 WHERE id = ?`,
      args: [history[0]!.id],
    });
  }
}

// ============================================================================
// Statistics and Reporting
// ============================================================================

/**
 * Get learning system statistics
 */
export async function getLearningStatistics(): Promise<{
  calibrations: ConfidenceCalibration[];
  episodicMemoryCount: number;
  recentDecisions: EpisodicMemoryRecord[];
  semanticPatternCount: number;
  highConfidencePatterns: SemanticPattern[];
  correctionRuleStats: {
    totalRules: number;
    activeRules: number;
    rulesByType: Record<string, number>;
    rulesBySource: Record<string, number>;
    mostApplied: Array<{ rule: CorrectionRule; count: number }>;
  };
}> {
  const db = getLibSQLClient();
  const rulesManager = getCorrectionRulesManager();

  // Get calibrations
  const calibrations = await getAllCalibrations();

  // Get episodic memory stats
  const episodicCountResult = await db.execute({
    sql: `SELECT COUNT(*) as count FROM episodic_memory`,
    args: [],
  });
  const episodicMemoryCount = (episodicCountResult.rows[0]?.count as number) || 0;

  // Get recent decisions
  const recentResult = await db.execute({
    sql: `SELECT * FROM episodic_memory ORDER BY timestamp DESC LIMIT 20`,
    args: [],
  });
  const recentDecisions = recentResult.rows.map((row) => ({
    id: row!.id as string,
    timestamp: row!.timestamp as string,
    entityId: row!.entity_id as string,
    entityName: row!.entity_name as string,
    actionType: row!.action_type as string,
    decision: row!.decision as EpisodicMemoryRecord['decision'],
    workflowRunId: row!.workflow_run_id as string | undefined,
    confidence: row!.confidence as number | undefined,
    reasoning: row!.reasoning as string | undefined,
    outcomeSuccessful: row!.outcome_successful === 1,
    outcomeNotes: row!.outcome_notes as string | undefined,
    metadata: JSON.parse((row!.metadata as string) || '{}'),
  }));

  // Get semantic pattern stats
  const patternCountResult = await db.execute({
    sql: `SELECT COUNT(*) as count FROM semantic_patterns`,
    args: [],
  });
  const semanticPatternCount = (patternCountResult.rows[0]?.count as number) || 0;

  // Get high confidence patterns
  const highConfidencePatterns = await getHighConfidencePatterns(0.7);

  // Get correction rule stats
  const correctionRuleStats = await rulesManager.getStatistics();

  return {
    calibrations,
    episodicMemoryCount,
    recentDecisions,
    semanticPatternCount,
    highConfidencePatterns,
    correctionRuleStats,
  };
}

export default {
  // Confidence calibration
  updateConfidenceCalibration,
  shouldAutoApprove,
  getAllCalibrations,

  // Episodic memory
  recordEpisodicMemory,
  recallSimilarDecisions,
  getEntityDecisionHistory,

  // Semantic patterns
  learnPattern,
  findRelevantPatterns,
  getHighConfidencePatterns,

  // Unified decision making
  makeInformedDecision,

  // Learning
  learnFromApproval,
  learnFromSuccessfulOperation,

  // Statistics
  getLearningStatistics,
};
