/**
 * T075: Correction Rule Storage
 * Implements FR-016, FR-017, FR-018: Learning from human feedback
 */

import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { getLibSQLClient } from '../index';

// Correction rule types
export const CorrectionRuleTypeSchema = z.enum([
  'do_not_merge',      // Never merge these patterns
  'always_merge',      // Auto-merge these patterns
  'require_approval',  // Always require approval for these patterns
  'field_priority',    // When merging, prefer this source's field values
  'brand_trust',       // Trust level for a specific brand's data
  'category_rule',     // Rules specific to a gear category
  'custom',            // Custom rule with condition and action
]);

export type CorrectionRuleType = z.infer<typeof CorrectionRuleTypeSchema>;

// Correction rule schema
export const CorrectionRuleSchema = z.object({
  id: z.string().uuid(),
  type: CorrectionRuleTypeSchema,
  name: z.string().min(1),
  description: z.string().optional(),
  condition: z.object({
    // Pattern matching conditions
    nodeLabels: z.array(z.string()).optional(),
    propertyPatterns: z.record(z.string()).optional(),
    similarityRange: z
      .object({
        min: z.number().min(0).max(1),
        max: z.number().min(0).max(1),
      })
      .optional(),
    brandPatterns: z.array(z.string()).optional(),
    categoryPatterns: z.array(z.string()).optional(),
  }),
  action: z.object({
    type: z.enum(['block', 'allow', 'require_approval', 'prefer_field']),
    parameters: z.record(z.unknown()).optional(),
  }),
  source: z.enum(['user_rejection', 'user_approval', 'manual', 'learned']),
  confidence: z.number().min(0).max(1).default(1.0),
  timesApplied: z.number().default(0),
  lastApplied: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
  active: z.boolean().default(true),
});

export type CorrectionRule = z.infer<typeof CorrectionRuleSchema>;

// Rule match result
export interface RuleMatchResult {
  matches: boolean;
  rule?: CorrectionRule;
  matchScore?: number;
  reason?: string;
}

/**
 * Correction Rules Manager
 */
export class CorrectionRulesManager {
  private rules: Map<string, CorrectionRule> = new Map();
  private loaded = false;

  /**
   * Load rules from database
   */
  async loadRules(): Promise<void> {
    const db = getLibSQLClient();

    const result = await db.execute({
      sql: `SELECT * FROM correction_rules WHERE active = 1`,
      args: [],
    });

    this.rules.clear();
    for (const row of result.rows) {
      const rule: CorrectionRule = {
        id: row.id as string,
        type: row.type as CorrectionRuleType,
        name: row.name as string,
        description: row.description as string | undefined,
        condition: JSON.parse(row.condition_json as string),
        action: JSON.parse(row.action_json as string),
        source: row.source as CorrectionRule['source'],
        confidence: row.confidence as number,
        timesApplied: row.times_applied as number,
        lastApplied: row.last_applied as string | undefined,
        createdAt: row.created_at as string,
        updatedAt: row.updated_at as string,
        expiresAt: row.expires_at as string | undefined,
        active: (row.active as number) === 1,
      };
      this.rules.set(rule.id, rule);
    }

    this.loaded = true;
  }

  /**
   * Create a new correction rule
   */
  async createRule(
    input: Omit<CorrectionRule, 'id' | 'timesApplied' | 'createdAt' | 'updatedAt'>
  ): Promise<CorrectionRule> {
    const now = new Date().toISOString();
    const rule: CorrectionRule = {
      ...input,
      id: uuidv4(),
      timesApplied: 0,
      createdAt: now,
      updatedAt: now,
    };

    const db = getLibSQLClient();
    await db.execute({
      sql: `INSERT INTO correction_rules
            (id, type, name, description, condition_json, action_json, source,
             confidence, times_applied, created_at, updated_at, expires_at, active)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        rule.id,
        rule.type,
        rule.name,
        rule.description || null,
        JSON.stringify(rule.condition),
        JSON.stringify(rule.action),
        rule.source,
        rule.confidence,
        rule.timesApplied,
        rule.createdAt,
        rule.updatedAt,
        rule.expiresAt || null,
        rule.active ? 1 : 0,
      ],
    });

    this.rules.set(rule.id, rule);
    return rule;
  }

  /**
   * Create a "do not merge" rule from a rejected merge
   */
  async createDoNotMergeRule(
    node1: { id: string; name?: string; brand?: string; category?: string },
    node2: { id: string; name?: string; brand?: string; category?: string },
    similarity: number,
    reason?: string
  ): Promise<CorrectionRule> {
    // Extract patterns from the rejected pair
    const patterns: Record<string, string> = {};
    if (node1.name && node2.name) {
      patterns.namePattern = extractPattern(node1.name, node2.name);
    }

    return this.createRule({
      type: 'do_not_merge',
      name: `Do not merge: ${node1.name || node1.id} & ${node2.name || node2.id}`,
      description: reason || 'Created from rejected merge',
      condition: {
        propertyPatterns: patterns,
        similarityRange: {
          min: Math.max(0, similarity - 0.05),
          max: Math.min(1, similarity + 0.05),
        },
        brandPatterns:
          node1.brand && node2.brand && node1.brand !== node2.brand
            ? [node1.brand, node2.brand]
            : undefined,
        categoryPatterns:
          node1.category || node2.category
            ? [node1.category, node2.category].filter(Boolean) as string[]
            : undefined,
      },
      action: {
        type: 'block',
        parameters: {
          originalNodes: [node1.id, node2.id],
        },
      },
      source: 'user_rejection',
      confidence: 1.0,
      active: true,
    });
  }

  /**
   * Check if a merge candidate matches any blocking rules
   */
  async checkMergeCandidate(
    node1: Record<string, unknown>,
    node2: Record<string, unknown>,
    similarity: number
  ): Promise<RuleMatchResult> {
    if (!this.loaded) {
      await this.loadRules();
    }

    for (const rule of this.rules.values()) {
      if (!rule.active) continue;
      if (rule.type !== 'do_not_merge' && rule.type !== 'require_approval') continue;

      // Check if expired
      if (rule.expiresAt && new Date(rule.expiresAt) < new Date()) {
        continue;
      }

      const matches = this.matchesCondition(rule.condition, node1, node2, similarity);
      if (matches.matches) {
        // Update usage stats
        await this.recordRuleApplication(rule.id);

        return {
          matches: true,
          rule,
          matchScore: matches.score,
          reason:
            rule.type === 'do_not_merge'
              ? `Blocked by rule: ${rule.name}`
              : `Requires approval by rule: ${rule.name}`,
        };
      }
    }

    return { matches: false };
  }

  /**
   * Check if nodes match a rule condition
   */
  private matchesCondition(
    condition: CorrectionRule['condition'],
    node1: Record<string, unknown>,
    node2: Record<string, unknown>,
    similarity: number
  ): { matches: boolean; score: number } {
    let score = 0;
    let checks = 0;

    // Check similarity range
    if (condition.similarityRange) {
      checks++;
      if (
        similarity >= condition.similarityRange.min &&
        similarity <= condition.similarityRange.max
      ) {
        score++;
      }
    }

    // Check property patterns
    if (condition.propertyPatterns) {
      for (const [key, pattern] of Object.entries(condition.propertyPatterns)) {
        checks++;
        const val1 = String(node1[key] || '');
        const val2 = String(node2[key] || '');
        if (matchesPattern(val1, pattern) || matchesPattern(val2, pattern)) {
          score++;
        }
      }
    }

    // Check brand patterns
    if (condition.brandPatterns && condition.brandPatterns.length > 0) {
      checks++;
      const brand1 = String(node1.brand || '').toLowerCase();
      const brand2 = String(node2.brand || '').toLowerCase();
      const matchesBrand = condition.brandPatterns.some(
        (p) => brand1.includes(p.toLowerCase()) || brand2.includes(p.toLowerCase())
      );
      if (matchesBrand) score++;
    }

    // Check category patterns
    if (condition.categoryPatterns && condition.categoryPatterns.length > 0) {
      checks++;
      const cat1 = String(node1.category || '').toLowerCase();
      const cat2 = String(node2.category || '').toLowerCase();
      const matchesCat = condition.categoryPatterns.some(
        (p) => cat1.includes(p.toLowerCase()) || cat2.includes(p.toLowerCase())
      );
      if (matchesCat) score++;
    }

    // Must match at least 50% of checks
    const matchRatio = checks > 0 ? score / checks : 0;
    return {
      matches: matchRatio >= 0.5,
      score: matchRatio,
    };
  }

  /**
   * Record that a rule was applied
   */
  private async recordRuleApplication(ruleId: string): Promise<void> {
    const rule = this.rules.get(ruleId);
    if (!rule) return;

    rule.timesApplied++;
    rule.lastApplied = new Date().toISOString();

    const db = getLibSQLClient();
    await db.execute({
      sql: `UPDATE correction_rules
            SET times_applied = ?, last_applied = ?
            WHERE id = ?`,
      args: [rule.timesApplied, rule.lastApplied, ruleId],
    });
  }

  /**
   * Get all active rules
   */
  async getActiveRules(): Promise<CorrectionRule[]> {
    if (!this.loaded) {
      await this.loadRules();
    }
    return Array.from(this.rules.values()).filter((r) => r.active);
  }

  /**
   * Get rule by ID
   */
  async getRule(id: string): Promise<CorrectionRule | null> {
    if (!this.loaded) {
      await this.loadRules();
    }
    return this.rules.get(id) || null;
  }

  /**
   * Deactivate a rule
   */
  async deactivateRule(id: string): Promise<void> {
    const db = getLibSQLClient();
    await db.execute({
      sql: `UPDATE correction_rules SET active = 0, updated_at = ? WHERE id = ?`,
      args: [new Date().toISOString(), id],
    });

    const rule = this.rules.get(id);
    if (rule) {
      rule.active = false;
    }
  }

  /**
   * Get rule statistics
   */
  async getStatistics(): Promise<{
    totalRules: number;
    activeRules: number;
    rulesByType: Record<string, number>;
    rulesBySource: Record<string, number>;
    mostApplied: Array<{ rule: CorrectionRule; count: number }>;
  }> {
    if (!this.loaded) {
      await this.loadRules();
    }

    const rules = Array.from(this.rules.values());
    const activeRules = rules.filter((r) => r.active);

    const rulesByType: Record<string, number> = {};
    const rulesBySource: Record<string, number> = {};

    for (const rule of activeRules) {
      rulesByType[rule.type] = (rulesByType[rule.type] || 0) + 1;
      rulesBySource[rule.source] = (rulesBySource[rule.source] || 0) + 1;
    }

    const mostApplied = [...activeRules]
      .sort((a, b) => b.timesApplied - a.timesApplied)
      .slice(0, 10)
      .map((rule) => ({ rule, count: rule.timesApplied }));

    return {
      totalRules: rules.length,
      activeRules: activeRules.length,
      rulesByType,
      rulesBySource,
      mostApplied,
    };
  }

  /**
   * Create a brand trust rule from successful enrichments
   */
  async createBrandTrustRule(
    brandName: string,
    trustLevel: 'high' | 'medium' | 'low',
    fieldPriorities?: string[],
    reason?: string
  ): Promise<CorrectionRule> {
    return this.createRule({
      type: 'brand_trust',
      name: `Brand trust: ${brandName} (${trustLevel})`,
      description: reason || `Learned brand trust from successful operations`,
      condition: {
        brandPatterns: [brandName.toLowerCase()],
      },
      action: {
        type: trustLevel === 'high' ? 'allow' : 'require_approval',
        parameters: {
          trustLevel,
          fieldPriorities: fieldPriorities || [],
        },
      },
      source: 'learned',
      confidence: trustLevel === 'high' ? 0.9 : trustLevel === 'medium' ? 0.7 : 0.5,
      active: true,
    });
  }

  /**
   * Create a category-specific rule
   */
  async createCategoryRule(
    category: string,
    ruleAction: 'require_approval' | 'allow',
    requiredFields?: string[],
    reason?: string
  ): Promise<CorrectionRule> {
    return this.createRule({
      type: 'category_rule',
      name: `Category rule: ${category}`,
      description: reason || `Learned rule for category ${category}`,
      condition: {
        categoryPatterns: [category.toLowerCase()],
      },
      action: {
        type: ruleAction,
        parameters: {
          requiredFields: requiredFields || [],
        },
      },
      source: 'learned',
      confidence: 0.75,
      active: true,
    });
  }

  /**
   * Get brand trust level
   */
  async getBrandTrustLevel(brandName: string): Promise<{
    trustLevel: 'high' | 'medium' | 'low' | 'unknown';
    rule?: CorrectionRule;
  }> {
    if (!this.loaded) {
      await this.loadRules();
    }

    const brandLower = brandName.toLowerCase();
    for (const rule of this.rules.values()) {
      if (!rule.active || rule.type !== 'brand_trust') continue;
      if (rule.condition.brandPatterns?.some((p) => brandLower.includes(p.toLowerCase()))) {
        return {
          trustLevel: (rule.action.parameters?.trustLevel as 'high' | 'medium' | 'low') || 'medium',
          rule,
        };
      }
    }

    return { trustLevel: 'unknown' };
  }

  /**
   * Get rules applicable to an entity
   */
  async getApplicableRules(entity: {
    brand?: string;
    category?: string;
    name?: string;
  }): Promise<CorrectionRule[]> {
    if (!this.loaded) {
      await this.loadRules();
    }

    const applicable: CorrectionRule[] = [];
    for (const rule of this.rules.values()) {
      if (!rule.active) continue;

      let matches = false;

      if (entity.brand && rule.condition.brandPatterns) {
        const brandLower = entity.brand.toLowerCase();
        if (rule.condition.brandPatterns.some((p) => brandLower.includes(p.toLowerCase()))) {
          matches = true;
        }
      }

      if (entity.category && rule.condition.categoryPatterns) {
        const catLower = entity.category.toLowerCase();
        if (rule.condition.categoryPatterns.some((p) => catLower.includes(p.toLowerCase()))) {
          matches = true;
        }
      }

      if (matches) {
        applicable.push(rule);
      }
    }

    return applicable;
  }

  /**
   * Find blocking rules for a proposed action
   */
  async findBlockingRule(
    action: { type: string; nodeId?: string; data?: Record<string, unknown> },
    entity?: { brand?: string; category?: string; name?: string }
  ): Promise<CorrectionRule | null> {
    if (!this.loaded) {
      await this.loadRules();
    }

    for (const rule of this.rules.values()) {
      if (!rule.active) continue;
      if (rule.action.type !== 'block') continue;

      // Check if expired
      if (rule.expiresAt && new Date(rule.expiresAt) < new Date()) {
        continue;
      }

      // Check brand/category match
      if (entity) {
        if (entity.brand && rule.condition.brandPatterns) {
          const brandLower = entity.brand.toLowerCase();
          if (rule.condition.brandPatterns.some((p) => brandLower.includes(p.toLowerCase()))) {
            await this.recordRuleApplication(rule.id);
            return rule;
          }
        }

        if (entity.category && rule.condition.categoryPatterns) {
          const catLower = entity.category.toLowerCase();
          if (rule.condition.categoryPatterns.some((p) => catLower.includes(p.toLowerCase()))) {
            await this.recordRuleApplication(rule.id);
            return rule;
          }
        }
      }
    }

    return null;
  }
}

/**
 * Extract a pattern from two similar strings
 */
function extractPattern(str1: string, str2: string): string {
  const words1 = str1.toLowerCase().split(/\s+/);
  const words2 = str2.toLowerCase().split(/\s+/);

  // Find common words
  const common = words1.filter((w) => words2.includes(w));
  if (common.length > 0) {
    return common.join(' ');
  }

  // Fall back to longest common substring
  return longestCommonSubstring(str1.toLowerCase(), str2.toLowerCase());
}

/**
 * Find longest common substring
 */
function longestCommonSubstring(str1: string, str2: string): string {
  const m = str1.length;
  const n = str2.length;
  const dp: number[][] = Array(m + 1)
    .fill(null)
    .map(() => Array(n + 1).fill(0));

  let maxLen = 0;
  let endIdx = 0;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (str1[i - 1] === str2[j - 1]) {
        dp[i]![j] = (dp[i - 1]?.[j - 1] ?? 0) + 1;
        if (dp[i]![j]! > maxLen) {
          maxLen = dp[i]![j]!;
          endIdx = i;
        }
      }
    }
  }

  return str1.substring(endIdx - maxLen, endIdx);
}

/**
 * Check if a string matches a pattern
 */
function matchesPattern(value: string, pattern: string): boolean {
  const valueLower = value.toLowerCase();
  const patternLower = pattern.toLowerCase();

  // Simple substring match
  return valueLower.includes(patternLower);
}

// Singleton instance
let correctionRulesManager: CorrectionRulesManager | null = null;

export function getCorrectionRulesManager(): CorrectionRulesManager {
  if (!correctionRulesManager) {
    correctionRulesManager = new CorrectionRulesManager();
  }
  return correctionRulesManager;
}
