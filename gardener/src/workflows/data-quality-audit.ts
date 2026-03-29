import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { extractJson } from "../lib/utils.js";

// ─── Schemas ─────────────────────────────────────────────────────────────────

const triggerSchema = z.object({
  scope: z.enum(["full", "brands", "products"]).default("full").describe("Scope of the audit"),
  maxFixes: z.number().default(50).describe("Maximum number of fixes to apply"),
});

const issueSchema = z.object({
  type: z.string(),
  severity: z.enum(["critical", "high", "medium", "low"]),
  description: z.string(),
  affectedNodes: z.number(),
  fixable: z.boolean(),
  query: z.string().optional(),
});

const qualityResultSchema = z.object({
  issues: z.array(issueSchema),
  totalIssues: z.number(),
});

const scoredSchema = z.object({
  fixableIssues: z.array(issueSchema),
  unfixableIssues: z.array(issueSchema),
  priorityScore: z.number(),
});

const fixResultSchema = z.object({
  fixed: z.number(),
  attempted: z.number(),
  details: z.string(),
});

const reportSchema = z.object({
  summary: z.string(),
  issuesFound: z.number(),
  issuesFixed: z.number(),
  issuesRemaining: z.number(),
  priorityScore: z.number(),
  report: z.string(),
});

// ─── Steps ───────────────────────────────────────────────────────────────────

const runQualityQueries = createStep({
  id: "run-quality-queries",
  inputSchema: triggerSchema,
  outputSchema: qualityResultSchema,
  execute: async ({ mastra }) => {
    const fallback = { issues: [] as Array<z.infer<typeof issueSchema>>, totalIssues: 0 };

    if (!mastra) throw new Error("Mastra context is required");
    const agent = mastra.getAgent("gardener");

    let result;
    try {
      result = await agent.generate(
        `Run a comprehensive data quality audit on the GearGraph. Execute these graphQuery queries:

      1. GearItems without weight_grams:
         MATCH (g:GearItem) WHERE g.weight_grams IS NULL RETURN count(g) AS count

      2. GearItems without price_usd:
         MATCH (g:GearItem) WHERE g.price_usd IS NULL AND g.price_eur IS NULL RETURN count(g) AS count

      3. Brands without any products:
         MATCH (b:OutdoorBrand) WHERE NOT (b)<-[:PRODUCED_BY]-() AND NOT (b)-[:MANUFACTURES_ITEM]->() RETURN count(b) AS count

      4. Products with duplicate names within same brand:
         MATCH (g1:GearItem), (g2:GearItem)
         WHERE g1.brand = g2.brand AND g1.name = g2.name AND id(g1) < id(g2)
         RETURN g1.brand AS brand, g1.name AS name, count(*) AS duplicates

      5. Products with suspicious weight (>50000g = 50kg):
         MATCH (g:GearItem) WHERE g.weight_grams > 50000 RETURN g.name, g.brand, g.weight_grams

      6. Products with suspicious price (>$5000):
         MATCH (g:GearItem) WHERE g.price_usd > 5000 RETURN g.name, g.brand, g.price_usd

      7. Orphan nodes (not connected to anything):
         MATCH (n) WHERE NOT (n)--() AND NOT n:OutdoorBrand RETURN labels(n)[0] AS label, count(n) AS count

      8. Brands without description:
         MATCH (b:OutdoorBrand) WHERE b.description IS NULL RETURN count(b) AS count

      9. Brands without website:
         MATCH (b:OutdoorBrand) WHERE b.website IS NULL RETURN count(b) AS count

      For each query result, classify the issue with severity:
      - critical: duplicates, data corruption
      - high: missing core fields on many nodes (>100)
      - medium: missing optional fields, suspicious values
      - low: cosmetic issues, small counts

      Return ONLY a JSON object:
      {
        "issues": [
          {
            "type": "<issue type>",
            "severity": "critical|high|medium|low",
            "description": "<what's wrong>",
            "affectedNodes": <count>,
            "fixable": <boolean>,
            "query": "<the query used>"
          }
        ],
        "totalIssues": <number>
      }`,
        { toolChoice: "required" },
      );
    } catch (err) {
      console.error("[run-quality-queries] agent.generate() failed:", err);
      return fallback;
    }

    const parsed = extractJson(result.text);
    if (parsed && typeof parsed === "object") {
      return parsed as z.infer<typeof qualityResultSchema>;
    }
    return fallback;
  },
});

const scoreIssues = createStep({
  id: "score-issues",
  inputSchema: qualityResultSchema,
  outputSchema: scoredSchema,
  execute: async ({ inputData: qualityResult }) => {
    const severityWeight: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };

    const scored = qualityResult.issues.map((issue) => ({
      ...issue,
      score: (severityWeight[issue.severity] || 1) * Math.log2(issue.affectedNodes + 1),
    }));

    scored.sort((a, b) => b.score - a.score);

    const fixable = scored.filter((i) => i.fixable);
    const unfixable = scored.filter((i) => !i.fixable);
    const totalScore = scored.reduce((sum, i) => sum + i.score, 0);

    return {
      fixableIssues: fixable,
      unfixableIssues: unfixable,
      priorityScore: Math.round(totalScore * 100) / 100,
    };
  },
});

const fixIssues = createStep({
  id: "fix-issues",
  inputSchema: scoredSchema,
  outputSchema: fixResultSchema,
  execute: async ({ inputData: scored, mastra, getInitData }) => {
    const { maxFixes } = getInitData<z.infer<typeof triggerSchema>>();

    if (scored.fixableIssues.length === 0) {
      return { fixed: 0, attempted: 0, details: "No fixable issues found" };
    }

    if (!mastra) throw new Error("Mastra context is required");
    const agent = mastra.getAgent("gardener");

    const topIssues = scored.fixableIssues.slice(0, maxFixes ?? 50);
    const issueList = topIssues
      .map((i, idx) => `${idx + 1}. [${i.severity}] ${i.description} (${i.affectedNodes} nodes)`)
      .join("\n");

    let result;
    try {
      result = await agent.generate(
        `Fix these data quality issues in the GearGraph:
      ${issueList}

      For each issue:
      1. Use graphQuery to find the specific affected nodes (LIMIT 20 per issue)
      2. For missing data (weight, price, description): use webSearch to research correct values
      3. Use validateSchema to validate any new data
      4. Use graphWrite with MERGE/SET to fix the data
      5. Always include sourceUrl and updatedAt

      IMPORTANT:
      - Never DELETE nodes — only SET properties
      - For suspicious values, research the correct value before overwriting
      - For duplicates, use the mergeNodes tool: pick the node with more data as keepGearId
      - Limit fixes to 20 nodes per issue to avoid runaway operations

      End your response with a JSON summary: { "writesSucceeded": <number>, "writesFailed": <number> }`,
        { toolChoice: "auto", maxSteps: 50 },
      );
    } catch (err) {
      console.error("[fix-issues] agent.generate() failed:", err);
      return { fixed: 0, attempted: topIssues.length, details: "Agent error during fix" };
    }

    const parsed = extractJson(result.text) as { writesSucceeded?: number } | null;
    return { fixed: parsed?.writesSucceeded ?? 0, attempted: topIssues.length, details: result.text };
  },
});

const generateReport = createStep({
  id: "generate-report",
  inputSchema: fixResultSchema,
  outputSchema: reportSchema,
  execute: async ({ inputData: fixes, getStepResult }) => {
    const scored = getStepResult(scoreIssues);
    const issuesFound = scored.fixableIssues.length + scored.unfixableIssues.length;
    const remaining = Math.max(0, issuesFound - fixes.fixed);

    const reportLines = [
      `# GearGraph Data Quality Audit Report`,
      `Date: ${new Date().toISOString()}`,
      ``,
      `## Summary`,
      `- Issues found: ${issuesFound}`,
      `- Issues fixed: ${fixes.fixed}`,
      `- Issues remaining: ${remaining}`,
      `- Priority score: ${scored.priorityScore}`,
      ``,
      `## Unfixable Issues (require human review)`,
      ...scored.unfixableIssues.map(
        (i) => `- [${i.severity.toUpperCase()}] ${i.description} (${i.affectedNodes} nodes)`,
      ),
      ``,
      `## Fixed Issues`,
      `- ${fixes.fixed} issues resolved out of ${fixes.attempted} attempted`,
    ];

    return {
      summary: `Audit complete: ${issuesFound} found, ${fixes.fixed} fixed, ${remaining} remaining`,
      issuesFound,
      issuesFixed: fixes.fixed,
      issuesRemaining: remaining,
      priorityScore: scored.priorityScore,
      report: reportLines.join("\n"),
    };
  },
});

// ─── Workflow ─────────────────────────────────────────────────────────────────

export const dataQualityAudit = createWorkflow({
  id: "data-quality-audit",
  inputSchema: triggerSchema,
  outputSchema: reportSchema,
})
  .then(runQualityQueries)
  .then(scoreIssues)
  .then(fixIssues)
  .then(generateReport)
  .commit();
