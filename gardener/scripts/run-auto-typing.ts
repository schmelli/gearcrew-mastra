/**
 * CLI runner for the auto-typing workflow (GEA-1085 / DATA-04).
 *
 * Usage:
 *   npm run auto-typing:dry-run-test  -- [--limit N] [--max-cost-cents N] [--batch-size N]
 *   npm run auto-typing:dry-run       -- [--limit N] [--max-cost-cents N]
 *   npm run auto-typing:apply         -- [--max-cost-cents N]
 *
 * Flags:
 *   --mode dry-run|apply       required
 *   --batch-size <n>           default 50
 *   --max-batches <n>          default 60
 *   --max-cost-cents <n>       default 1000 ($10 hard cap)
 *   --limit <n>                cap total items (override max_batches*batch_size)
 *   --confidence-threshold <n> default 0.75
 *   --dry-run-test             skip ALL Supabase writes (offline smoke-test)
 *   --help / -h                show help
 *
 * Exits 1 on workflow failure, on aborted_due_to_cost=true (apply only),
 * or on bilanz_check=false.
 */

import { mastra } from "../src/mastra/index.js";

interface CliArgs {
  mode?: "dry-run" | "apply";
  batchSize: number;
  maxBatches: number;
  maxCostCents: number;
  confidenceThreshold: number;
  limit?: number;
  dryRunTest: boolean;
  retypeAll: boolean;
}

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_MAX_BATCHES = 60;
const DEFAULT_MAX_COST_CENTS = 1000;
const DEFAULT_CONFIDENCE_THRESHOLD = 0.75;

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    batchSize: DEFAULT_BATCH_SIZE,
    maxBatches: DEFAULT_MAX_BATCHES,
    maxCostCents: DEFAULT_MAX_COST_CENTS,
    confidenceThreshold: DEFAULT_CONFIDENCE_THRESHOLD,
    dryRunTest: false,
    retypeAll: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--mode": {
        const next = argv[i + 1];
        if (next !== "dry-run" && next !== "apply") {
          throw new Error(
            `--mode must be "dry-run" or "apply", got: ${next}`,
          );
        }
        args.mode = next;
        i += 1;
        break;
      }
      case "--batch-size": {
        const next = argv[i + 1];
        const n = next ? parseInt(next, 10) : NaN;
        if (Number.isNaN(n) || n <= 0) {
          throw new Error("--batch-size requires a positive integer");
        }
        args.batchSize = n;
        i += 1;
        break;
      }
      case "--max-batches": {
        const next = argv[i + 1];
        const n = next ? parseInt(next, 10) : NaN;
        if (Number.isNaN(n) || n <= 0) {
          throw new Error("--max-batches requires a positive integer");
        }
        args.maxBatches = n;
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
      case "--confidence-threshold": {
        const next = argv[i + 1];
        const n = next ? parseFloat(next) : NaN;
        if (Number.isNaN(n) || n < 0 || n > 1) {
          throw new Error(
            "--confidence-threshold requires a number between 0 and 1",
          );
        }
        args.confidenceThreshold = n;
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
  const help = `Usage: npm run auto-typing:<mode> -- [options]

Required:
  --mode dry-run|apply

Optional:
  --batch-size <n>           default ${DEFAULT_BATCH_SIZE}
  --max-batches <n>          default ${DEFAULT_MAX_BATCHES}
  --max-cost-cents <n>       default ${DEFAULT_MAX_COST_CENTS} (\$${DEFAULT_MAX_COST_CENTS / 100} hard cap)
  --limit <n>                cap total items
  --confidence-threshold <n> default ${DEFAULT_CONFIDENCE_THRESHOLD}
  --dry-run-test             skip ALL Supabase writes (offline)
  --retype-all               re-classify ALL gear_items (not just product_type_id IS NULL)
  --help                     show this help`;
  console.log(help);
  process.exit(code);
}

interface SampleResult {
  gear_item_id: string;
  item_name: string;
  suggested_product_type_id: string | null;
  suggested_label: string | null;
  confidence: number;
  reasoning: string;
  bucket: "high" | "low" | "failed";
}

interface WorkflowResult {
  mode: "dry-run" | "apply";
  workflow_run_id: string;
  items_processed: number;
  items_typed_confidently: number;
  items_in_review_queue: number;
  items_failed: number;
  cost_cents_used: number;
  aborted_due_to_cost: boolean;
  audit_log_ids: string[];
  batches_processed: number;
  bilanz_check: boolean;
  sample_results: SampleResult[];
}

function summarizeSample(s: SampleResult): string {
  const label = s.suggested_label ?? "(none)";
  return `  [${s.confidence.toFixed(2)}] "${s.item_name}" → "${label}" — ${s.reasoning.slice(0, 100)}`;
}

function printSummary(result: WorkflowResult): void {
  console.log("\n=== AUTO-TYPING SUMMARY ===");
  console.log(`Mode:                   ${result.mode}`);
  console.log(`Workflow run id:        ${result.workflow_run_id}`);
  console.log(`Items processed:        ${result.items_processed}`);
  console.log(`Typed confidently:      ${result.items_typed_confidently}`);
  console.log(`In review queue:        ${result.items_in_review_queue}`);
  console.log(`Failed:                 ${result.items_failed}`);
  console.log(
    `Bilanz check:           ${result.bilanz_check ? "PASS" : "FAIL"} (${result.items_typed_confidently} + ${result.items_in_review_queue} + ${result.items_failed} = ${result.items_typed_confidently + result.items_in_review_queue + result.items_failed} vs ${result.items_processed})`,
  );
  console.log(`Cost (cents):           ${result.cost_cents_used}`);
  console.log(`Aborted due to cost:    ${result.aborted_due_to_cost}`);
  console.log(`Batches processed:      ${result.batches_processed}`);
  console.log(`Audit log ids:          ${result.audit_log_ids.length}`);

  if (result.sample_results.length === 0) {
    console.log("\n(no sample results returned)");
    return;
  }

  const high = result.sample_results.filter((s) => s.bucket === "high");
  const low = result.sample_results.filter((s) => s.bucket === "low");
  const failed = result.sample_results.filter((s) => s.bucket === "failed");

  if (high.length > 0) {
    console.log("\n--- High-confidence samples (top 5) ---");
    for (const s of high.slice(0, 5)) console.log(summarizeSample(s));
  }
  if (low.length > 0) {
    console.log("\n--- Low-confidence samples (top 5, review-queue) ---");
    for (const s of low.slice(0, 5)) console.log(summarizeSample(s));
  }
  if (failed.length > 0) {
    console.log("\n--- Failed samples (top 5) ---");
    for (const s of failed.slice(0, 5)) console.log(summarizeSample(s));
  }
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));

  if (!cli.mode) {
    console.error("ERROR: --mode is required (dry-run or apply)");
    printHelpAndExit(1);
  }

  interface AutoTypingInput {
    mode: "dry-run" | "apply";
    batch_size: number;
    max_batches: number;
    max_cost_cents: number;
    confidence_threshold: number;
    dry_run_test: boolean;
    retype_all: boolean;
    limit?: number;
  }

  const inputData: AutoTypingInput = {
    mode: cli.mode,
    batch_size: cli.batchSize,
    max_batches: cli.maxBatches,
    max_cost_cents: cli.maxCostCents,
    confidence_threshold: cli.confidenceThreshold,
    dry_run_test: cli.dryRunTest,
    retype_all: cli.retypeAll,
  };
  if (cli.limit !== undefined) inputData.limit = cli.limit;

  console.log(
    `[auto-typing] starting workflow mode=${cli.mode} batch_size=${cli.batchSize} max_batches=${cli.maxBatches} max_cost_cents=${cli.maxCostCents} confidence_threshold=${cli.confidenceThreshold} limit=${cli.limit ?? "none"} dry_run_test=${cli.dryRunTest}`,
  );

  const workflow = mastra.getWorkflow("autoTypingFlash");
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
    console.error(`\n[auto-typing] WORKFLOW FAILED: ${errMsg}`);
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
    !("items_processed" in result)
  ) {
    console.error(
      "\n[auto-typing] FAILED: workflow returned unexpected shape",
      JSON.stringify(runResult).slice(0, 500),
    );
    process.exitCode = 1;
    return;
  }

  printSummary(result);

  if (!result.bilanz_check) {
    console.error("\n[auto-typing] FAILED: bilanz_check=false");
    process.exitCode = 1;
  }
  if (result.mode === "apply" && result.aborted_due_to_cost) {
    console.error(
      "\n[auto-typing] FAILED: aborted_due_to_cost=true in apply mode",
    );
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error("[auto-typing] FAILED:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    // Force-exit because mastra/index.ts starts cron schedulers at module-import
    // time that keep the event loop alive. CLI runs are one-shot.
    process.exit(process.exitCode ?? 0);
  });
