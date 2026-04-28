/**
 * CLI runner for the brand-dedup workflow (GEA-1083 / DATA-02).
 *
 * Usage:
 *   npm run brand-dedup:dry-run -- [--snapshot-path <path>] [--max-cost-cents N] [--dry-run-test]
 *   npm run brand-dedup:apply -- --cluster-id <uuid>
 *
 * Flags:
 *   --mode <dry-run|apply>     required (set automatically by npm scripts)
 *   --cluster-id <uuid>        required for --mode apply
 *   --snapshot-path <path>     filesystem path to top-brands-snapshot.json
 *                              (default: hardcoded gearshack-winterberry path)
 *   --max-cost-cents <n>       hard cost cap; default 1000 = \$10
 *   --dry-run-test             skip Supabase writes (local smoke-test mode)
 *
 * Exits 1 on any thrown error or aborted_due_to_cost=true.
 */

import { mastra } from "../src/mastra/index.js";
import { closeDriver } from "../src/lib/memgraph.js";

interface CliArgs {
  mode?: "dry-run" | "apply";
  clusterId?: string;
  snapshotPath?: string;
  maxCostCents: number;
  dryRunTest: boolean;
}

const DEFAULT_MAX_COST_CENTS = 1000;

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    maxCostCents: DEFAULT_MAX_COST_CENTS,
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
      case "--cluster-id": {
        const next = argv[i + 1];
        if (!next) throw new Error("--cluster-id requires a value");
        args.clusterId = next;
        i += 1;
        break;
      }
      case "--snapshot-path": {
        const next = argv[i + 1];
        if (!next) throw new Error("--snapshot-path requires a value");
        args.snapshotPath = next;
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
  const help = `Usage: npm run brand-dedup:<mode> -- [options]

Required (one of):
  --mode dry-run        Cluster all brands; write proposals to brand_dedup_queue
  --mode apply          Apply a single approved cluster's merge to Memgraph

Apply-mode required:
  --cluster-id <uuid>   Cluster to apply (must have status='approved' or 'modified')

Optional:
  --snapshot-path <p>   Top-brands snapshot JSON path (default: gearshack-winterberry)
  --max-cost-cents <n>  Hard cost cap; default ${DEFAULT_MAX_COST_CENTS} (\$10)
  --dry-run-test        Skip Supabase writes (local smoke-test mode; dry-run only)
  --help                Show this help`;
  console.log(help);
  process.exit(code);
}

interface ClusterSummary {
  cluster_id: string;
  canonical_candidate: string;
  alias_count: number;
  llm_confidence: number;
  llm_reasoning: string;
}

interface DryRunResult {
  mode: "dry-run";
  clusters?: Array<{
    cluster_id: string;
    canonical_candidate: string;
    aliases: Array<{ name: string; item_count?: number }>;
    llm_confidence: number;
    llm_reasoning: string;
  }>;
  total_clusters?: number;
  total_items_affected?: number;
  estimated_cost_cents?: number;
  failed_inserts?: string[];
  cost_cents_used: number;
  aborted_due_to_cost: boolean;
  workflow_run_id: string;
}

interface ApplyResult {
  mode: "apply";
  cluster_id?: string;
  merged_items?: number;
  alias_edges_created?: number;
  cost_cents_used: number;
  aborted_due_to_cost: boolean;
  workflow_run_id: string;
}

type WorkflowResult = DryRunResult | ApplyResult;

function summarizeClusters(
  clusters: NonNullable<DryRunResult["clusters"]>,
): ClusterSummary[] {
  return clusters.map((c) => ({
    cluster_id: c.cluster_id,
    canonical_candidate: c.canonical_candidate,
    alias_count: c.aliases.length,
    llm_confidence: c.llm_confidence,
    llm_reasoning: c.llm_reasoning.slice(0, 120),
  }));
}

function printDryRunSummary(result: DryRunResult): void {
  console.log("\n=== BRAND-DEDUP DRY-RUN SUMMARY ===");
  console.log(`Workflow run id:        ${result.workflow_run_id}`);
  console.log(`Total clusters:         ${result.total_clusters ?? 0}`);
  console.log(`Total items affected:   ${result.total_items_affected ?? 0}`);
  console.log(`Estimated cost (cents): ${result.estimated_cost_cents ?? 0}`);
  console.log(`Actual cost (cents):    ${result.cost_cents_used}`);
  console.log(`Aborted due to cost:    ${result.aborted_due_to_cost}`);
  console.log(`Failed queue inserts:   ${(result.failed_inserts ?? []).length}`);

  if (!result.clusters || result.clusters.length === 0) {
    console.log("\n(no clusters returned)");
    return;
  }

  const all = summarizeClusters(result.clusters);
  const sorted = [...all].sort((a, b) => b.llm_confidence - a.llm_confidence);
  const high = sorted.slice(0, 5);
  const low = sorted.slice(-5).reverse();

  console.log("\n--- Top 5 by confidence ---");
  for (const c of high) {
    console.log(
      `  [${c.llm_confidence.toFixed(2)}] ${c.canonical_candidate} (${c.alias_count} alias${c.alias_count === 1 ? "" : "es"})`,
    );
    console.log(`     reasoning: ${c.llm_reasoning}${c.llm_reasoning.length >= 120 ? "..." : ""}`);
  }
  console.log("\n--- Bottom 5 by confidence ---");
  for (const c of low) {
    console.log(
      `  [${c.llm_confidence.toFixed(2)}] ${c.canonical_candidate} (${c.alias_count} alias${c.alias_count === 1 ? "" : "es"})`,
    );
    console.log(`     reasoning: ${c.llm_reasoning}${c.llm_reasoning.length >= 120 ? "..." : ""}`);
  }

  // Anchor-cluster verification (GEA-1083 acceptance criteria).
  console.log("\n--- Anchor-cluster check (acceptance criteria) ---");
  const anchors = ["Therm-a-Rest", "Black Diamond", "Hyperlite Mountain Gear"];
  for (const anchor of anchors) {
    const found = result.clusters.find(
      (c) =>
        c.canonical_candidate.toLowerCase().includes(anchor.toLowerCase().split(" ")[0]) ||
        c.aliases.some((a) =>
          a.name.toLowerCase().includes(anchor.toLowerCase().split(" ")[0]),
        ),
    );
    if (found) {
      const ok = found.llm_confidence >= 0.85 ? "PASS" : "FAIL";
      console.log(
        `  [${ok}] ${anchor} → canonical="${found.canonical_candidate}", aliases=${found.aliases.length}, confidence=${found.llm_confidence.toFixed(2)}`,
      );
    } else {
      console.log(`  [MISS] ${anchor} — no matching cluster found`);
    }
  }
}

function printApplySummary(result: ApplyResult): void {
  console.log("\n=== BRAND-DEDUP APPLY SUMMARY ===");
  console.log(`Workflow run id:        ${result.workflow_run_id}`);
  console.log(`Cluster id:             ${result.cluster_id}`);
  console.log(`GearItem edges merged:  ${result.merged_items ?? 0}`);
  console.log(`Alias edges created:    ${result.alias_edges_created ?? 0}`);
  console.log(`Cost (cents):           ${result.cost_cents_used}`);
}

function isDryRun(r: WorkflowResult): r is DryRunResult {
  return r.mode === "dry-run";
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));

  if (!cli.mode) {
    console.error("ERROR: --mode is required (dry-run or apply)");
    printHelpAndExit(1);
  }
  if (cli.mode === "apply" && !cli.clusterId) {
    console.error("ERROR: --cluster-id is required for --mode apply");
    printHelpAndExit(1);
  }
  if (cli.mode === "apply" && cli.dryRunTest) {
    console.error("ERROR: --dry-run-test is not valid with --mode apply");
    process.exit(1);
  }

  interface BrandDedupInput {
    mode: "dry-run" | "apply";
    max_cost_cents: number;
    dry_run_test: boolean;
    top_brands_snapshot_url?: string;
    cluster_id?: string;
  }

  const inputData: BrandDedupInput = {
    mode: cli.mode,
    max_cost_cents: cli.maxCostCents,
    dry_run_test: cli.dryRunTest,
  };
  if (cli.snapshotPath) inputData.top_brands_snapshot_url = cli.snapshotPath;
  if (cli.clusterId) inputData.cluster_id = cli.clusterId;

  console.log(
    `[brand-dedup] starting workflow mode=${cli.mode} max_cost_cents=${cli.maxCostCents} dry_run_test=${cli.dryRunTest}`,
  );

  const workflow = mastra.getWorkflow("brandDedup");
  const run = await workflow.createRunAsync();
  const runResult = await run.start({ inputData });

  // Mastra v0.24.x WorkflowResult shape: { status: 'success' | 'failed', result?, error?, steps }
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
    console.error(`\n[brand-dedup] WORKFLOW FAILED: ${errMsg}`);
    process.exitCode = 1;
    return;
  }

  // Pull the route-and-execute step output (fallback paths cover Mastra version drift).
  const stepOutput = wrapped.steps?.["route-and-execute"] as
    | { output?: unknown }
    | undefined;
  const inner = wrapped.result ?? stepOutput?.output ?? runResult;

  const result = inner as WorkflowResult;

  if (!result || typeof result !== "object" || !("mode" in result)) {
    console.error(
      "\n[brand-dedup] FAILED: workflow returned unexpected shape",
      JSON.stringify(runResult).slice(0, 500),
    );
    process.exitCode = 1;
    return;
  }

  if (isDryRun(result)) {
    printDryRunSummary(result);
  } else {
    printApplySummary(result as ApplyResult);
  }

  if (result.aborted_due_to_cost) {
    console.error(
      "\n[brand-dedup] FAILED: aborted_due_to_cost=true — cost cap exceeded",
    );
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error("[brand-dedup] FAILED:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await closeDriver();
    } catch (err) {
      console.error("[brand-dedup] Failed to close Memgraph driver:", err);
    }
    // Force-exit because mastra/index.ts starts cron schedulers (brandCategoryScan
    // + youtubePlaylistIngest) at module-import time that keep the event loop
    // alive. CLI runs are one-shot — they should not hang on the schedulers.
    process.exit(process.exitCode ?? 0);
  });
