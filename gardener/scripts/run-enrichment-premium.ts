/**
 * CLI runner for the enrichmentPremium workflow (Quick-Task 260428-ke7 / DATA-07).
 *
 * Usage:
 *   npm run enrichment-premium:dry-run-test  -- [--target description|insights|both] [--limit N]
 *   npm run enrichment-premium:dry-run       -- [--target description|insights|both] [--max-cost-cents N]
 *   npm run enrichment-premium:apply         -- [--target description|insights|both] [--max-cost-cents N]
 *
 * Flags:
 *   --mode dry-run|apply               required
 *   --target description|insights|both default both
 *   --max-cost-cents <n>               default 1000 ($10 hard cap)
 *   --limit <n>                        default 50
 *   --dry-run-test                     skip ALL Supabase + Memgraph writes
 *   --retype-all                       reserved (currently no-op)
 *   --help / -h                        show help
 *
 * Exits 1 on workflow failure, on aborted_due_to_cost=true (apply only),
 * or on bilanz_check=false.
 */

import { mastra } from "../src/mastra/index.js";

interface CliArgs {
  mode?: "dry-run" | "apply";
  target: "description" | "insights" | "both";
  maxCostCents: number;
  limit: number;
  dryRunTest: boolean;
  retypeAll: boolean;
}

const DEFAULT_TARGET = "both" as const;
const DEFAULT_MAX_COST_CENTS = 1000;
const DEFAULT_LIMIT = 50;

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    target: DEFAULT_TARGET,
    maxCostCents: DEFAULT_MAX_COST_CENTS,
    limit: DEFAULT_LIMIT,
    dryRunTest: false,
    retypeAll: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--mode": {
        const next = argv[i + 1];
        if (next !== "dry-run" && next !== "apply") {
          throw new Error(`--mode must be "dry-run" or "apply", got: ${next}`);
        }
        args.mode = next;
        i += 1;
        break;
      }
      case "--target": {
        const next = argv[i + 1];
        if (
          next !== "description" &&
          next !== "insights" &&
          next !== "both"
        ) {
          throw new Error(
            `--target must be "description", "insights", or "both", got: ${next}`,
          );
        }
        args.target = next;
        i += 1;
        break;
      }
      case "--max-cost-cents": {
        const next = argv[i + 1];
        const n = next ? parseInt(next, 10) : NaN;
        if (Number.isNaN(n) || n <= 0) {
          throw new Error("--max-cost-cents requires a positive integer");
        }
        args.maxCostCents = n;
        i += 1;
        break;
      }
      case "--limit": {
        const next = argv[i + 1];
        const n = next ? parseInt(next, 10) : NaN;
        if (Number.isNaN(n) || n <= 0) {
          throw new Error("--limit requires a positive integer");
        }
        args.limit = n;
        i += 1;
        break;
      }
      case "--dry-run-test":
        args.dryRunTest = true;
        break;
      case "--retype-all":
        args.retypeAll = true;
        break;
      case "--help":
      case "-h":
        printHelpAndExit(0);
        break;
      default:
        if (arg && arg.startsWith("--")) {
          console.error(`Unknown argument: ${arg}`);
          printHelpAndExit(1);
        }
        break;
    }
  }
  return args;
}

function printHelpAndExit(code: number): never {
  const help = `Usage: npm run enrichment-premium:<mode> -- [options]

Required:
  --mode dry-run|apply

Optional:
  --target description|insights|both   default ${DEFAULT_TARGET}
  --max-cost-cents <n>                 default ${DEFAULT_MAX_COST_CENTS} (\$${DEFAULT_MAX_COST_CENTS / 100} hard cap)
  --limit <n>                          default ${DEFAULT_LIMIT}
  --dry-run-test                       skip ALL Supabase + Memgraph writes
  --retype-all                         reserved (no-op for now)
  --help                               show this help`;
  console.log(help);
  process.exit(code);
}

interface DescriptionSample {
  item_id: string;
  item_name: string;
  bucket: "generated" | "skipped_good" | "failed";
  word_count: number | null;
  cost_cents: number;
  preview: string | null;
  reason: string | null;
}

interface InsightsSample {
  item_id: string;
  item_name: string;
  bucket: "created" | "no_videos" | "no_insights" | "failed";
  videos_examined: number;
  insights_created: number;
  insights_existing: number;
  cost_cents: number;
  reason: string | null;
}

interface WorkflowResult {
  mode: "dry-run" | "apply";
  target: "description" | "insights" | "both";
  workflow_run_id: string;
  description_items_processed: number;
  descriptions_generated: number;
  descriptions_skipped_good: number;
  descriptions_failed: number;
  description_audit_log_ids: string[];
  insights_items_processed: number;
  insights_total_created: number;
  insights_items_no_videos: number;
  insights_items_no_insights: number;
  insights_items_failed: number;
  insights_audit_log_ids: string[];
  cost_cents_used: number;
  aborted_due_to_cost: boolean;
  description_coverage_before: { total: number; with_not_null: number };
  description_coverage_after: { total: number; with_not_null: number };
  bilanz_check: boolean;
  sample_descriptions: DescriptionSample[];
  sample_insights: InsightsSample[];
}

function summarizeDescription(s: DescriptionSample): string {
  const wc = s.word_count !== null ? `${s.word_count}w` : "no-words";
  const reason = s.reason ? ` [${s.reason.slice(0, 60)}]` : "";
  const preview = s.preview ? ` — "${s.preview.slice(0, 80)}…"` : "";
  return `  [${s.bucket}] ${wc} (${s.cost_cents}¢) "${s.item_name}"${preview}${reason}`;
}

function summarizeInsights(s: InsightsSample): string {
  const reason = s.reason ? ` [${s.reason.slice(0, 60)}]` : "";
  return `  [${s.bucket}] videos=${s.videos_examined} created=${s.insights_created} existing=${s.insights_existing} (${s.cost_cents}¢) "${s.item_name}"${reason}`;
}

function printSummary(result: WorkflowResult): void {
  console.log("\n=== ENRICHMENT-PREMIUM SUMMARY ===");
  console.log(`Mode:                   ${result.mode}`);
  console.log(`Target:                 ${result.target}`);
  console.log(`Workflow run id:        ${result.workflow_run_id}`);
  console.log("");
  console.log("--- DESCRIPTION ---");
  console.log(
    `Items processed:        ${result.description_items_processed}`,
  );
  console.log(`Generated:              ${result.descriptions_generated}`);
  console.log(
    `Skipped (already-good): ${result.descriptions_skipped_good}`,
  );
  console.log(`Failed:                 ${result.descriptions_failed}`);
  console.log(
    `Audit-log ids:          ${result.description_audit_log_ids.length}`,
  );
  console.log("");
  console.log("--- INSIGHTS ---");
  console.log(
    `Items processed:        ${result.insights_items_processed}`,
  );
  console.log(`Insights created:       ${result.insights_total_created}`);
  console.log(`No videos:              ${result.insights_items_no_videos}`);
  console.log(`No insights extracted:  ${result.insights_items_no_insights}`);
  console.log(`Failed:                 ${result.insights_items_failed}`);
  console.log(
    `Audit-log ids:          ${result.insights_audit_log_ids.length}`,
  );
  console.log("");
  console.log("--- AGGREGATE ---");
  console.log(`Cost (cents):           ${result.cost_cents_used}`);
  console.log(`Aborted due to cost:    ${result.aborted_due_to_cost}`);
  console.log(
    `Bilanz check:           ${result.bilanz_check ? "PASS" : "FAIL"}`,
  );
  console.log(
    `Description coverage:   before=${result.description_coverage_before.with_not_null}/${result.description_coverage_before.total} → after=${result.description_coverage_after.with_not_null}/${result.description_coverage_after.total}`,
  );

  if (result.sample_descriptions.length > 0) {
    console.log("\n--- Description samples ---");
    const generated = result.sample_descriptions.filter(
      (s) => s.bucket === "generated",
    );
    if (generated.length > 0) {
      console.log("Generated (top 5):");
      for (const s of generated.slice(0, 5)) console.log(summarizeDescription(s));
    }
    const skipped = result.sample_descriptions.filter(
      (s) => s.bucket === "skipped_good",
    );
    if (skipped.length > 0) {
      console.log(`\nSkipped (already-good, ${skipped.length}):`);
      for (const s of skipped.slice(0, 5)) console.log(summarizeDescription(s));
    }
    const failed = result.sample_descriptions.filter(
      (s) => s.bucket === "failed",
    );
    if (failed.length > 0) {
      console.log(`\nFailed (${failed.length}):`);
      for (const s of failed.slice(0, 5)) console.log(summarizeDescription(s));
    }
  }

  if (result.sample_insights.length > 0) {
    console.log("\n--- Insights samples ---");
    const created = result.sample_insights.filter(
      (s) => s.bucket === "created",
    );
    if (created.length > 0) {
      console.log("Created (top 5):");
      for (const s of created.slice(0, 5)) console.log(summarizeInsights(s));
    }
    const skipped = result.sample_insights.filter(
      (s) => s.bucket === "no_videos" || s.bucket === "no_insights",
    );
    if (skipped.length > 0) {
      console.log(`\nNo extraction (${skipped.length}):`);
      for (const s of skipped.slice(0, 5)) console.log(summarizeInsights(s));
    }
    const failed = result.sample_insights.filter((s) => s.bucket === "failed");
    if (failed.length > 0) {
      console.log(`\nFailed (${failed.length}):`);
      for (const s of failed.slice(0, 5)) console.log(summarizeInsights(s));
    }
  }
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));

  if (!cli.mode) {
    console.error("ERROR: --mode is required (dry-run or apply)");
    printHelpAndExit(1);
  }

  interface PremiumInput {
    mode: "dry-run" | "apply";
    target: "description" | "insights" | "both";
    max_cost_cents: number;
    limit: number;
    dry_run_test: boolean;
    retype_all: boolean;
  }

  const inputData: PremiumInput = {
    mode: cli.mode,
    target: cli.target,
    max_cost_cents: cli.maxCostCents,
    limit: cli.limit,
    dry_run_test: cli.dryRunTest,
    retype_all: cli.retypeAll,
  };

  console.log(
    `[enrichment-premium] starting workflow mode=${cli.mode} target=${cli.target} max_cost_cents=${cli.maxCostCents} limit=${cli.limit} dry_run_test=${cli.dryRunTest}`,
  );

  const workflow = mastra.getWorkflow("enrichmentPremium");
  const run = await workflow.createRunAsync();
  const runResult = await run.start({ inputData });

  const wrapped = runResult as {
    status?: "success" | "failed";
    result?: unknown;
    error?: unknown;
    steps?: Record<string, unknown>;
  };

  if (wrapped.status === "failed") {
    const errMsg =
      wrapped.error instanceof Error
        ? wrapped.error.message
        : typeof wrapped.error === "string"
          ? wrapped.error
          : JSON.stringify(wrapped.error);
    console.error(`\n[enrichment-premium] WORKFLOW FAILED: ${errMsg}`);
    process.exitCode = 1;
    return;
  }

  const stepOutput = wrapped.steps?.["route-and-execute"] as
    | { output?: unknown }
    | undefined;
  const inner = wrapped.result ?? stepOutput?.output ?? runResult;

  const result = inner as WorkflowResult | undefined;

  if (
    !result ||
    typeof result !== "object" ||
    !("workflow_run_id" in result) ||
    !("bilanz_check" in result)
  ) {
    console.error(
      "\n[enrichment-premium] FAILED: workflow returned unexpected shape",
      JSON.stringify(runResult).slice(0, 500),
    );
    process.exitCode = 1;
    return;
  }

  printSummary(result);

  if (!result.bilanz_check) {
    console.error("\n[enrichment-premium] FAILED: bilanz_check=false");
    process.exitCode = 1;
  }
  if (result.mode === "apply" && result.aborted_due_to_cost) {
    console.error(
      "\n[enrichment-premium] FAILED: aborted_due_to_cost=true in apply mode",
    );
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error("[enrichment-premium] FAILED:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    process.exit(process.exitCode ?? 0);
  });
