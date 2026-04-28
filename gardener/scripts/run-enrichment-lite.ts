/**
 * CLI runner for the enrichmentLite workflow (Phase 09 / DATA-05 + DATA-06).
 *
 * Usage:
 *   npm run enrichment-lite:dry-run-test  -- [--target weight|image|both] [--limit N]
 *   npm run enrichment-lite:dry-run       -- [--target weight|image|both] [--max-cost-cents N]
 *   npm run enrichment-lite:apply         -- [--target weight|image|both] [--max-cost-cents N]
 *
 * Flags:
 *   --mode dry-run|apply        required
 *   --target weight|image|both  default both
 *   --max-cost-cents <n>        default 500 ($5 hard cap, scope-reduced)
 *   --confidence-threshold <n>  default 0.85
 *   --limit <n>                 default 200 (safety guard)
 *   --inter-request-delay-ms n  default 500 (image og:image fetch politeness)
 *   --dry-run-test              skip ALL Supabase writes (offline smoke-test)
 *   --help / -h                 show help
 *
 * Exits 1 on workflow failure, on aborted_due_to_cost=true (apply only),
 * or on bilanz_check=false.
 */

import { mastra } from "../src/mastra/index.js";

interface CliArgs {
  mode?: "dry-run" | "apply";
  target: "weight" | "image" | "both";
  maxCostCents: number;
  confidenceThreshold: number;
  limit: number;
  interRequestDelayMs: number;
  dryRunTest: boolean;
}

const DEFAULT_TARGET = "both" as const;
const DEFAULT_MAX_COST_CENTS = 500;
const DEFAULT_CONFIDENCE_THRESHOLD = 0.85;
const DEFAULT_LIMIT = 200;
const DEFAULT_INTER_REQUEST_DELAY_MS = 500;

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    target: DEFAULT_TARGET,
    maxCostCents: DEFAULT_MAX_COST_CENTS,
    confidenceThreshold: DEFAULT_CONFIDENCE_THRESHOLD,
    limit: DEFAULT_LIMIT,
    interRequestDelayMs: DEFAULT_INTER_REQUEST_DELAY_MS,
    dryRunTest: false,
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
        if (next !== "weight" && next !== "image" && next !== "both") {
          throw new Error(
            `--target must be "weight", "image", or "both", got: ${next}`,
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
      case "--inter-request-delay-ms": {
        const next = argv[i + 1];
        const n = next ? parseInt(next, 10) : NaN;
        if (Number.isNaN(n) || n < 0) {
          throw new Error(
            "--inter-request-delay-ms requires a non-negative integer",
          );
        }
        args.interRequestDelayMs = n;
        i += 1;
        break;
      }
      case "--dry-run-test":
        args.dryRunTest = true;
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
  const help = `Usage: npm run enrichment-lite:<mode> -- [options]

Required:
  --mode dry-run|apply

Optional:
  --target weight|image|both        default ${DEFAULT_TARGET}
  --max-cost-cents <n>              default ${DEFAULT_MAX_COST_CENTS} (\$${DEFAULT_MAX_COST_CENTS / 100} hard cap)
  --confidence-threshold <n>        default ${DEFAULT_CONFIDENCE_THRESHOLD}
  --limit <n>                       default ${DEFAULT_LIMIT}
  --inter-request-delay-ms <n>      default ${DEFAULT_INTER_REQUEST_DELAY_MS}
  --dry-run-test                    skip ALL Supabase writes (offline)
  --help                            show this help`;
  console.log(help);
  process.exit(code);
}

interface SampleWeight {
  item_id: string;
  item_name: string;
  weight_grams: number | null;
  confidence: number;
  reasoning: string;
  bucket: "confident" | "low_conf" | "failed";
}

interface SampleImage {
  item_id: string;
  item_name: string;
  product_url: string | null;
  image_url: string | null;
  source: string | null;
  bucket: "found" | "no_url" | "no_og_image" | "fetch_error";
  error?: string;
}

interface WorkflowResult {
  mode: "dry-run" | "apply";
  target: "weight" | "image" | "both";
  workflow_run_id: string;
  weight_items_processed: number;
  weights_extracted_confident: number;
  weight_low_conf: number;
  weight_failed: number;
  weight_gaps_recorded: number;
  weight_audit_log_ids: string[];
  image_items_processed: number;
  images_extracted: number;
  image_failed: number;
  image_gaps_recorded: number;
  image_audit_log_ids: string[];
  cost_cents_used: number;
  aborted_due_to_cost: boolean;
  coverage_before: { total: number; weight_pct: number; image_pct: number };
  coverage_after: { total: number; weight_pct: number; image_pct: number };
  bilanz_check: boolean;
  sample_weights: SampleWeight[];
  sample_images: SampleImage[];
}

function summarizeWeight(s: SampleWeight): string {
  const w = s.weight_grams === null ? "null" : `${s.weight_grams}g`;
  return `  [${s.confidence.toFixed(2)}] "${s.item_name}" → ${w} — ${s.reasoning.slice(0, 100)}`;
}

function summarizeImage(s: SampleImage): string {
  const url = s.image_url ? s.image_url.slice(0, 60) + "…" : "(none)";
  const err = s.error ? ` [${s.error}]` : "";
  return `  [${s.bucket}] "${s.item_name}" → ${url}${err}`;
}

function printSummary(result: WorkflowResult): void {
  console.log("\n=== ENRICHMENT-LITE SUMMARY ===");
  console.log(`Mode:                   ${result.mode}`);
  console.log(`Target:                 ${result.target}`);
  console.log(`Workflow run id:        ${result.workflow_run_id}`);
  console.log("");
  console.log("--- WEIGHT ---");
  console.log(`Items processed:        ${result.weight_items_processed}`);
  console.log(`Confident:              ${result.weights_extracted_confident}`);
  console.log(`Low-conf:               ${result.weight_low_conf}`);
  console.log(`Failed:                 ${result.weight_failed}`);
  console.log(`Gaps recorded:          ${result.weight_gaps_recorded}`);
  console.log(`Audit-log ids:          ${result.weight_audit_log_ids.length}`);
  console.log("");
  console.log("--- IMAGE ---");
  console.log(`Items processed:        ${result.image_items_processed}`);
  console.log(`Extracted:              ${result.images_extracted}`);
  console.log(`Failed:                 ${result.image_failed}`);
  console.log(`Gaps recorded:          ${result.image_gaps_recorded}`);
  console.log(`Audit-log ids:          ${result.image_audit_log_ids.length}`);
  console.log("");
  console.log("--- AGGREGATE ---");
  console.log(`Cost (cents):           ${result.cost_cents_used}`);
  console.log(`Aborted due to cost:    ${result.aborted_due_to_cost}`);
  console.log(
    `Bilanz check:           ${result.bilanz_check ? "PASS" : "FAIL"}`,
  );
  console.log(
    `Coverage before:        weight=${result.coverage_before.weight_pct}% image=${result.coverage_before.image_pct}% (n=${result.coverage_before.total})`,
  );
  console.log(
    `Coverage after:         weight=${result.coverage_after.weight_pct}% image=${result.coverage_after.image_pct}% (n=${result.coverage_after.total})`,
  );

  if (result.sample_weights.length > 0) {
    console.log("\n--- Weight samples (top 5 confident) ---");
    const conf = result.sample_weights.filter((s) => s.bucket === "confident");
    for (const s of conf.slice(0, 5)) console.log(summarizeWeight(s));
    const lowOrFailed = result.sample_weights.filter(
      (s) => s.bucket !== "confident",
    );
    if (lowOrFailed.length > 0) {
      console.log("\n--- Weight samples (top 5 low-conf/failed) ---");
      for (const s of lowOrFailed.slice(0, 5)) console.log(summarizeWeight(s));
    }
  }

  if (result.sample_images.length > 0) {
    console.log("\n--- Image samples (top 10) ---");
    for (const s of result.sample_images.slice(0, 10))
      console.log(summarizeImage(s));
  }
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));

  if (!cli.mode) {
    console.error("ERROR: --mode is required (dry-run or apply)");
    printHelpAndExit(1);
  }

  interface EnrichmentInput {
    mode: "dry-run" | "apply";
    target: "weight" | "image" | "both";
    max_cost_cents: number;
    confidence_threshold: number;
    limit: number;
    inter_request_delay_ms: number;
    dry_run_test: boolean;
  }

  const inputData: EnrichmentInput = {
    mode: cli.mode,
    target: cli.target,
    max_cost_cents: cli.maxCostCents,
    confidence_threshold: cli.confidenceThreshold,
    limit: cli.limit,
    inter_request_delay_ms: cli.interRequestDelayMs,
    dry_run_test: cli.dryRunTest,
  };

  console.log(
    `[enrichment-lite] starting workflow mode=${cli.mode} target=${cli.target} max_cost_cents=${cli.maxCostCents} limit=${cli.limit} dry_run_test=${cli.dryRunTest}`,
  );

  const workflow = mastra.getWorkflow("enrichmentLite");
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
    console.error(`\n[enrichment-lite] WORKFLOW FAILED: ${errMsg}`);
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
      "\n[enrichment-lite] FAILED: workflow returned unexpected shape",
      JSON.stringify(runResult).slice(0, 500),
    );
    process.exitCode = 1;
    return;
  }

  printSummary(result);

  if (!result.bilanz_check) {
    console.error("\n[enrichment-lite] FAILED: bilanz_check=false");
    process.exitCode = 1;
  }
  if (result.mode === "apply" && result.aborted_due_to_cost) {
    console.error(
      "\n[enrichment-lite] FAILED: aborted_due_to_cost=true in apply mode",
    );
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error("[enrichment-lite] FAILED:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    process.exit(process.exitCode ?? 0);
  });
