/**
 * CLI runner for the type-dedup workflow (GEA-1084 / DATA-03).
 *
 * Usage:
 *   npm run type-dedup:dry-run-test -- [--max-cost-cents N] [--top-n N] [--output-path DIR]
 *   npm run type-dedup:dry-run      -- [--max-cost-cents N] [--top-n N] [--output-path DIR]
 *
 * Flags:
 *   --mode dry-run             only valid value (apply mode does not exist)
 *   --max-cost-cents <n>       hard cost cap; default 200 = $2
 *   --dry-run-test             skip filesystem write (smoke-test mode)
 *   --output-path <dir>        override export output directory
 *   --top-n <n>                top-N product types to cluster; default 50
 *   --help / -h                show help
 *
 * Exits 1 on any thrown error or aborted_due_to_cost=true.
 */

import { mastra } from "../src/mastra/index.js";

interface CliArgs {
  mode?: "dry-run";
  maxCostCents: number;
  dryRunTest: boolean;
  outputPath?: string;
  topN: number;
}

const DEFAULT_MAX_COST_CENTS = 200;
const DEFAULT_TOP_N = 50;

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    maxCostCents: DEFAULT_MAX_COST_CENTS,
    dryRunTest: false,
    topN: DEFAULT_TOP_N,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--mode": {
        const next = argv[i + 1];
        if (next !== "dry-run") {
          throw new Error(
            `--mode must be "dry-run" (apply mode does not exist), got: ${next}`,
          );
        }
        args.mode = next;
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
      case "--top-n": {
        const next = argv[i + 1];
        const n = next ? parseInt(next, 10) : NaN;
        if (Number.isNaN(n) || n <= 0) {
          throw new Error("--top-n requires a positive integer");
        }
        args.topN = n;
        i += 1;
        break;
      }
      case "--output-path": {
        const next = argv[i + 1];
        if (!next) throw new Error("--output-path requires a value");
        args.outputPath = next;
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
  const help = `Usage: npm run type-dedup:<mode> -- [options]

Required:
  --mode dry-run        only valid value (apply mode does not exist for type-dedup)

Optional:
  --max-cost-cents <n>  hard cost cap; default ${DEFAULT_MAX_COST_CENTS} (\$2)
  --top-n <n>           top-N product types to cluster; default ${DEFAULT_TOP_N}
  --output-path <dir>   override export output directory
  --dry-run-test        skip filesystem write (smoke-test mode)
  --help                Show this help`;
  console.log(help);
  process.exit(code);
}

interface ClusterRow {
  cluster_id: string;
  canonical_category_id: string;
  canonical_label: string;
  alias_category_ids: string[];
  alias_labels: string[];
  gender_hint: "mens" | "womens" | null;
  llm_confidence: number;
  llm_reasoning: string;
  affected_item_count: number;
}

interface DryRunResult {
  items_processed: number;
  clusters: ClusterRow[];
  export_json_url: string;
  cost_cents_used: number;
  aborted_due_to_cost: boolean;
  audit_log_ids: string[];
  workflow_run_id: string;
}

function topByItemCount(clusters: ClusterRow[], n: number): ClusterRow[] {
  return [...clusters]
    .sort((a, b) => b.affected_item_count - a.affected_item_count)
    .slice(0, n);
}

function bottomByConfidence(clusters: ClusterRow[], n: number): ClusterRow[] {
  return [...clusters]
    .sort((a, b) => a.llm_confidence - b.llm_confidence)
    .slice(0, n);
}

function summarizeCluster(c: ClusterRow): string {
  const aliasCount = c.alias_category_ids.length;
  const gender = c.gender_hint ? ` [${c.gender_hint}]` : "";
  return `  [${c.llm_confidence.toFixed(2)}] "${c.canonical_label}"${gender} — ${aliasCount} alias${aliasCount === 1 ? "" : "es"}, ${c.affected_item_count} items`;
}

function printSummary(result: DryRunResult): void {
  console.log("\n=== TYPE-DEDUP DRY-RUN SUMMARY ===");
  console.log(`Workflow run id:        ${result.workflow_run_id}`);
  console.log(`Items processed:        ${result.items_processed}`);
  console.log(`Total clusters:         ${result.clusters.length}`);
  console.log(`Cost (cents):           ${result.cost_cents_used}`);
  console.log(`Aborted due to cost:    ${result.aborted_due_to_cost}`);
  console.log(`Export JSON URL:        ${result.export_json_url}`);
  console.log(
    `Audit log ids:          ${result.audit_log_ids.length} (expected 0 — read-only)`,
  );

  if (result.clusters.length === 0) {
    console.log("\n(no clusters returned)");
    return;
  }

  const top5 = topByItemCount(result.clusters, 5);
  const low5 = bottomByConfidence(result.clusters, 5);

  console.log("\n--- Top 5 by affected_item_count ---");
  for (const c of top5) {
    console.log(summarizeCluster(c));
    console.log(
      `     aliases: ${c.alias_labels.slice(0, 5).join(", ")}${c.alias_labels.length > 5 ? ", ..." : ""}`,
    );
  }
  console.log("\n--- Bottom 5 by confidence ---");
  for (const c of low5) {
    console.log(summarizeCluster(c));
    console.log(`     reasoning: ${c.llm_reasoning.slice(0, 120)}`);
  }

  // Anchor-cluster checks (acceptance criteria).
  console.log("\n--- Anchor-cluster check (acceptance criteria) ---");
  const anchors = ["Daypack", "Tent", "Sleeping Bag"];
  for (const anchor of anchors) {
    const found = result.clusters.find(
      (c) =>
        c.canonical_label.toLowerCase().includes(anchor.toLowerCase()) ||
        c.alias_labels.some((a) =>
          a.toLowerCase().includes(anchor.toLowerCase()),
        ),
    );
    if (found) {
      const ok = found.llm_confidence >= 0.85 ? "PASS" : "WARN";
      const gender = found.gender_hint ? ` gender_hint=${found.gender_hint}` : "";
      console.log(
        `  [${ok}] ${anchor} → canonical="${found.canonical_label}", aliases=${found.alias_category_ids.length}, confidence=${found.llm_confidence.toFixed(2)}${gender}`,
      );
    } else {
      console.log(`  [MISS] ${anchor} — no matching cluster found`);
    }
  }

  // Gender coverage report.
  const withGender = result.clusters.filter((c) => c.gender_hint !== null);
  console.log(
    `\n--- Gender-hint coverage: ${withGender.length}/${result.clusters.length} clusters have gender_hint set ---`,
  );
  for (const c of withGender.slice(0, 10)) {
    console.log(
      `  [${c.gender_hint}] "${c.canonical_label}" — aliases: ${c.alias_labels.join(", ")}`,
    );
  }

  // Sort verification.
  const sorted = [...result.clusters].sort((a, b) =>
    a.canonical_label.toLowerCase().localeCompare(b.canonical_label.toLowerCase()),
  );
  let inOrder = true;
  for (let i = 0; i < sorted.length; i += 1) {
    if (sorted[i].cluster_id !== result.clusters[i].cluster_id) {
      inOrder = false;
      break;
    }
  }
  console.log(
    `\n--- Sort check: ${inOrder ? "PASS" : "FAIL"} (alphabetic by canonical_label) ---`,
  );
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));

  if (!cli.mode) {
    console.error("ERROR: --mode is required (only 'dry-run' is valid)");
    printHelpAndExit(1);
  }

  interface TypeDedupInput {
    mode: "dry-run";
    max_cost_cents: number;
    dry_run_test: boolean;
    top_n: number;
    output_dir_override?: string;
  }

  const inputData: TypeDedupInput = {
    mode: cli.mode,
    max_cost_cents: cli.maxCostCents,
    dry_run_test: cli.dryRunTest,
    top_n: cli.topN,
  };
  if (cli.outputPath) inputData.output_dir_override = cli.outputPath;

  console.log(
    `[type-dedup] starting workflow mode=${cli.mode} max_cost_cents=${cli.maxCostCents} top_n=${cli.topN} dry_run_test=${cli.dryRunTest}`,
  );

  const workflow = mastra.getWorkflow("typeDedup");
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
    console.error(`\n[type-dedup] WORKFLOW FAILED: ${errMsg}`);
    process.exitCode = 1;
    return;
  }

  const stepOutput = wrapped.steps?.["route-and-execute"] as
    | { output?: unknown }
    | undefined;
  const inner = wrapped.result ?? stepOutput?.output ?? runResult;

  const result = inner as DryRunResult | undefined;

  if (
    !result ||
    typeof result !== "object" ||
    !("clusters" in result) ||
    !("workflow_run_id" in result)
  ) {
    console.error(
      "\n[type-dedup] FAILED: workflow returned unexpected shape",
      JSON.stringify(runResult).slice(0, 500),
    );
    process.exitCode = 1;
    return;
  }

  printSummary(result);

  if (result.aborted_due_to_cost) {
    console.error(
      "\n[type-dedup] FAILED: aborted_due_to_cost=true — cost cap exceeded",
    );
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error("[type-dedup] FAILED:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    // Force-exit because mastra/index.ts starts cron schedulers at module-import
    // time that keep the event loop alive. CLI runs are one-shot.
    process.exit(process.exitCode ?? 0);
  });
