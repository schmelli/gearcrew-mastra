/**
 * T083: Schema Validation Step
 * Validates node schemas as part of the morning-hygiene workflow
 * Implements FR-020, FR-021: Detect and report schema violations
 */

import { z } from 'zod';
import { getMemgraphClient } from '@/lib/memgraph-client';
import { getAuditLogger } from './audit-logger';

// ============================================================================
// Schema Definitions
// ============================================================================

/**
 * Product node required fields schema
 */
export const ProductSchemaRequired = z.object({
  id: z.string(),
  name: z.string(),
});

/**
 * Product node full schema
 */
export const ProductSchemaFull = ProductSchemaRequired.extend({
  brand: z.string().optional(),
  category: z.string().optional(),
  weight_grams: z.number().optional(),
  price: z.number().optional(),
  description: z.string().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});

/**
 * Brand node schema
 */
export const BrandSchema = z.object({
  id: z.string(),
  name: z.string(),
  website: z.string().url().optional(),
  country: z.string().optional(),
});

/**
 * Category node schema
 */
export const CategorySchema = z.object({
  id: z.string(),
  name: z.string(),
  parent_id: z.string().optional(),
});

// Registry of schemas by label
const SCHEMA_REGISTRY: Record<string, z.ZodSchema> = {
  Product: ProductSchemaFull,
  GearItem: ProductSchemaFull,
  Brand: BrandSchema,
  Category: CategorySchema,
};

// ============================================================================
// Types
// ============================================================================

export interface SchemaViolation {
  nodeId: string;
  nodeLabel: string;
  field: string;
  issue: 'missing' | 'invalid_type' | 'invalid_value' | 'invalid_format';
  expected: string;
  actual: string | null;
  severity: 'error' | 'warning';
}

export interface SchemaValidationResult {
  label: string;
  totalNodes: number;
  validNodes: number;
  invalidNodes: number;
  violations: SchemaViolation[];
  validatedAt: string;
}

export interface FullValidationResult {
  results: SchemaValidationResult[];
  totalViolations: number;
  totalNodesChecked: number;
  healthScore: number;
  validatedAt: string;
}

// ============================================================================
// Validation Functions
// ============================================================================

/**
 * Validate all nodes of a specific label against their schema
 */
export async function validateNodeLabel(
  label: string,
  options?: { limit?: number; sample?: boolean }
): Promise<SchemaValidationResult> {
  const client = getMemgraphClient();
  const schema = SCHEMA_REGISTRY[label];
  const limit = options?.limit || 1000;

  if (!schema) {
    return {
      label,
      totalNodes: 0,
      validNodes: 0,
      invalidNodes: 0,
      violations: [],
      validatedAt: new Date().toISOString(),
    };
  }

  // Get nodes
  const query = options?.sample
    ? `MATCH (n:${label}) WITH n, rand() as r ORDER BY r LIMIT ${limit} RETURN n`
    : `MATCH (n:${label}) RETURN n LIMIT ${limit}`;

  const results = await client.readOnlyQuery<{ n: Record<string, unknown> }>(query);
  const violations: SchemaViolation[] = [];

  let validCount = 0;
  let invalidCount = 0;

  for (const { n: node } of results) {
    const nodeViolations = validateNode(node, label, schema);
    if (nodeViolations.length === 0) {
      validCount++;
    } else {
      invalidCount++;
      violations.push(...nodeViolations);
    }
  }

  return {
    label,
    totalNodes: results.length,
    validNodes: validCount,
    invalidNodes: invalidCount,
    violations: violations.slice(0, 100), // Limit violations returned
    validatedAt: new Date().toISOString(),
  };
}

/**
 * Validate a single node against a schema
 */
function validateNode(
  node: Record<string, unknown>,
  label: string,
  schema: z.ZodSchema
): SchemaViolation[] {
  const violations: SchemaViolation[] = [];
  const nodeId = String(node.id || 'unknown');

  try {
    schema.parse(node);
  } catch (error) {
    if (error instanceof z.ZodError) {
      for (const issue of error.issues) {
        violations.push({
          nodeId,
          nodeLabel: label,
          field: issue.path.join('.'),
          issue: mapZodIssue(issue.code),
          expected: issue.message,
          actual: String(node[issue.path[0] as string] ?? null),
          severity: issue.path.includes('id') || issue.path.includes('name') ? 'error' : 'warning',
        });
      }
    }
  }

  return violations;
}

/**
 * Map Zod issue code to our issue type
 */
function mapZodIssue(code: z.ZodIssueCode): SchemaViolation['issue'] {
  switch (code) {
    case 'invalid_type':
      return 'invalid_type';
    case 'invalid_string':
    case 'invalid_enum_value':
      return 'invalid_format';
    default:
      return 'invalid_value';
  }
}

/**
 * Run full schema validation across all registered labels
 */
export async function validateAllSchemas(
  options?: { limit?: number; sample?: boolean }
): Promise<FullValidationResult> {
  const results: SchemaValidationResult[] = [];
  let totalViolations = 0;
  let totalNodes = 0;

  for (const label of Object.keys(SCHEMA_REGISTRY)) {
    const result = await validateNodeLabel(label, options);
    results.push(result);
    totalViolations += result.violations.length;
    totalNodes += result.totalNodes;
  }

  // Calculate health score (percentage of valid nodes)
  const totalValid = results.reduce((sum, r) => sum + r.validNodes, 0);
  const healthScore = totalNodes > 0 ? (totalValid / totalNodes) * 100 : 100;

  return {
    results,
    totalViolations,
    totalNodesChecked: totalNodes,
    healthScore,
    validatedAt: new Date().toISOString(),
  };
}

/**
 * Run schema validation as part of morning hygiene workflow
 */
export async function runSchemaValidationStep(
  workflowRunId: string
): Promise<{
  success: boolean;
  healthScore: number;
  violations: number;
  issues: Array<{ label: string; count: number }>;
}> {
  const logger = getAuditLogger();

  try {
    const validation = await validateAllSchemas({ limit: 500, sample: true });

    // Log validation to audit
    if (validation.totalViolations > 0) {
      const issuesByLabel = validation.results
        .filter((r) => r.violations.length > 0)
        .map((r) => ({
          label: r.label,
          count: r.violations.length,
        }));

      // Log as flag action
      await logger.logFlag(
        workflowRunId,
        'morning-hygiene',
        'schema-validation',
        'WorkflowStep',
        {
          reasoning: `Found ${validation.totalViolations} schema violations across ${issuesByLabel.length} labels`,
        }
      );

      return {
        success: true,
        healthScore: validation.healthScore,
        violations: validation.totalViolations,
        issues: issuesByLabel,
      };
    }

    return {
      success: true,
      healthScore: validation.healthScore,
      violations: 0,
      issues: [],
    };
  } catch (error) {
    await logger.logError(
      workflowRunId,
      'morning-hygiene',
      'schema-validation',
      'WorkflowStep',
      error instanceof Error ? error.message : 'Schema validation failed'
    );

    return {
      success: false,
      healthScore: 0,
      violations: -1,
      issues: [],
    };
  }
}

/**
 * Format validation results for chat/reporting
 */
export function formatValidationReport(result: FullValidationResult): string {
  const lines: string[] = [];

  lines.push('**Schema Validation Report**\n');
  lines.push(`Health Score: ${result.healthScore.toFixed(1)}%`);
  lines.push(`Total Nodes Checked: ${result.totalNodesChecked.toLocaleString()}`);
  lines.push(`Total Violations: ${result.totalViolations}`);
  lines.push('');

  for (const labelResult of result.results) {
    if (labelResult.violations.length > 0) {
      lines.push(`**${labelResult.label}**: ${labelResult.invalidNodes} invalid of ${labelResult.totalNodes}`);

      const topViolations = labelResult.violations.slice(0, 3);
      for (const v of topViolations) {
        lines.push(`  - ${v.nodeId}: ${v.field} - ${v.issue}`);
      }
      if (labelResult.violations.length > 3) {
        lines.push(`  ...and ${labelResult.violations.length - 3} more`);
      }
    }
  }

  return lines.join('\n');
}
