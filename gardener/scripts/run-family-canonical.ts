/**
 * CLI runner for the family-canonical-names workflow (Quick-Task 260430-fam).
 *
 * Usage:
 *   npm run family-canonical:dry-run -- [--max-cost-cents N] [--family-limit N] [--dry-run-test]
 *   npm run family-canonical:apply -- --queue-id <uuid>
 *
 * Flags:
 *   --mode <dry-run|apply>    required (set automatically by npm scripts)
 *   --queue-id <uuid>         required for --mode apply (family_canonical_queue.id)
 *   --max-cost-cents <n>      hard cost cap; default 1000 = $10
 *   --family-limit <n>        snapshot only first N families (debugging only)
 *   --dry-run-test            skip Supabase writes (local smoke-test mode)
 *
 * Exits 1 on any thrown error or aborted_due_to_cost=true.
 */

import { mastra } from "../src/mastra/index.js";
import { closeDriver } from "../src/lib/memgraph.js";

interface CliArgs {
  mode?: "dry-run" | "apply";
  queueId?: string;
  maxCostCents: number;
  familyLimit?: number;
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
      case "--queue-id": {
        const next = argv[i + 1];
        if (!next) throw new Error("--queue-id requires a value");
        args.queueId = next;
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
      case "--family-limit": {
        const next = argv[i + 1];
        const n = next ? parseInt(next, 10) : NaN;
        if (Number.isNaN(n) || n <= 0) {
          throw new Error("--family-limit requires a positive integer");
        }
        args.familyLimit = n;
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
  const help = `Usage: npm run family-canonical:<mode> -- [options]

Required (one of):
  --mode dry-run            Snapshot ProductFamilies + classify; write to family_canonical_queue
  --mode apply              Apply a single approved queue row's mutation to Memgraph

Apply-mode required:
  --queue-id <uuid>         family_canonical_queue.id (must have status='approved' or 'modified')

Optional:
  --max-cost-cents <n>      Hard cost cap; default ${DEFAULT_MAX_COST_CENTS} ($10)
  --family-limit <n>        Snapshot only first N families (smoke-test only)
  --dry-run-test            Skip Supabase writes (local smoke-test mode; dry-run only)
  --help                    Show this help`;
  console.log(help);
  process.exit(code);
}

interface ProposalSummary {
  family_node_id: string;
  classification: "genuine" | "generic" | "ambiguous";
  canonical: string;
  llm_confidence: number;
  llm_reasoning: string;
}

interface DryRunResult {
  mode: "dry-run";
  proposals?: Array<{
    family_node_id: string;
    classification: "genuine" | "generic" | "ambiguous";
    proposed_canonical_name: string | null;
    proposed_brand_name: string | null;
    llm_confidence: number;
    llm_reasoning: string;
  }>;
  total_proposals?: number;
  total_families_snapshotted?: number;
  estimated_cost_cents?: number;
  failed_inserts?: string[];
  distribution?: { genuine: number; generic: number; ambiguous: number };
  cost_cents_used: number;
  aborted_due_to_cost: boolean;
  workflow_run_id: string;
}

interface ApplyResult {
  mode: "apply";
  queue_id?: string;
  family_node_id?: string;
  classification?: "genuine" | "generic" | "ambiguous";
  variants_unlinked?: number;
  cost_cents_used: number;
  aborted_due_to_cost: boolean;
  workflow_run_id: string;
}

type WorkflowResult = DryRunResult | ApplyResult;

function summarizeProposals(
  proposals: NonNullable<DryRunResult["proposals"]>,
): ProposalSummary[] {
  return proposals.map((p) => ({
    family_node_id: p.family_node_id,
    classification: p.classification,
    canonical: p.proposed_canonical_name ?? "(null)",
    llm_confidence: p.llm_confidence,
    llm_reasoning: p.llm_reasoning.slice(0, 120),
  }));
}

function printDryRunSummary(result: DryRunResult): void {
  console.log("\n=== FAMILY-CANONICAL DRY-RUN SUMMARY ===");
  console.log(`Workflow run id:           ${result.workflow_run_id}`);
  console.log(`Families snapshotted:      ${result.total_families_snapshotted ?? 0}`);
  console.log(`Total classifications:     ${result.total_proposals ?? 0}`);
  if (result.distribution) {
    console.log(
      `Distribution:              genuine=${result.distribution.genuine}, generic=${result.distribution.generic}, ambiguous=${result.distribution.ambiguous}`,
    );
  }
  console.log(`Estimated cost (cents):    ${result.estimated_cost_cents ?? 0}`);
  console.log(`Actual cost (cents):       ${result.cost_cents_used}`);
  console.log(`Aborted due to cost:       ${result.aborted_due_to_cost}`);
  console.log(`Failed queue inserts:      ${(result.failed_inserts ?? []).length}`);

  if (!result.proposals || result.proposals.length === 0) {
    console.log("\n(no proposals returned)");
    return;
  }

  const all = summarizeProposals(result.proposals);
  const byClass: Record<string, ProposalSummary[]> = {
    genuine: [],
    generic: [],
    ambiguous: [],
  };
  for (const p of all) byClass[p.classification].push(p);

  for (const cls of ["genuine", "generic", "ambiguous"] as const) {
    const items = byClass[cls];
    if (items.length === 0) continue;
    const sample = [...items]
      .sort((a, b) => b.llm_confidence - a.llm_confidence)
      .slice(0, 5);
    console.log(`\n--- Top 5 ${cls} (by confidence) ---`);
    for (const p of sample) {
      console.log(
        `  [${p.llm_confidence.toFixed(2)}] node=${p.family_node_id} canonical="${p.canonical}"`,
      );
      console.log(
        `     reasoning: ${p.llm_reasoning}${p.llm_reasoning.length >= 120 ? "..." : ""}`,
      );
    }
  }

  // Anchor-class check (acceptance criteria from PLAN.md)
  console.log("\n--- Anchor-class verification ---");
  const checks = [
    { name: "Backpacks", expected: "generic" as const },
    { name: "Sleeping Mats", expected: "generic" as const },
    { name: "Tensor Series", expected: "genuine" as const },
    { name: "Copper Spur HV UL", expected: "genuine" as const },
    { name: "Astro Pro", expected: "genuine" as const },
  ];
  for (const check of checks) {
    const found = result.proposals.find((p) =>
      p.proposed_canonical_name?.toLowerCase().includes(check.name.toLowerCase()) ??
      false,
    );
    if (found) {
      const ok = found.classification === check.expected ? "PASS" : "FAIL";
      console.log(
        `  [${ok}] "${check.name}" → ${found.classification} (expected ${check.expected})`,
      );
    } else {
      console.log(`  [MISS] "${check.name}" — no matching proposal found`);
    }
  }
}

function printApplySummary(result: ApplyResult): void {
  console.log("\n=== FAMILY-CANONICAL APPLY SUMMARY ===");
  console.log(`Workflow run id:           ${result.workflow_run_id}`);
  console.log(`Queue id:                  ${result.queue_id}`);
  console.log(`Family node id:            ${result.family_node_id}`);
  console.log(`Classification:            ${result.classification}`);
  console.log(`Variants unlinked:         ${result.variants_unlinked ?? 0}`);
  console.log(`Cost (cents):              ${result.cost_cents_used}`);
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
  if (cli.mode === "apply" && !cli.queueId) {
    console.error("ERROR: --queue-id is required for --mode apply");
    printHelpAndExit(1);
  }
  if (cli.mode === "apply" && cli.dryRunTest) {
    console.error("ERROR: --dry-run-test is not valid with --mode apply");
    process.exit(1);
  }

  interface FamilyCanonicalInput {
    mode: "dry-run" | "apply";
    max_cost_cents: number;
    dry_run_test: boolean;
    queue_id?: string;
    family_limit?: number;
  }

  const inputData: FamilyCanonicalInput = {
    mode: cli.mode,
    max_cost_cents: cli.maxCostCents,
    dry_run_test: cli.dryRunTest,
  };
  if (cli.queueId) inputData.queue_id = cli.queueId;
  if (cli.familyLimit) inputData.family_limit = cli.familyLimit;

  console.log(
    `[family-canonical] starting workflow mode=${cli.mode} max_cost_cents=${cli.maxCostCents} dry_run_test=${cli.dryRunTest}${cli.familyLimit ? ` family_limit=${cli.familyLimit}` : ""}`,
  );

  const workflow = mastra.getWorkflow("familyCanonical");
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
    console.error(`\n[family-canonical] WORKFLOW FAILED: ${errMsg}`);
    process.exitCode = 1;
    return;
  }

  const stepOutput = wrapped.steps?.["route-and-execute"] as
    | { output?: unknown }
    | undefined;
  const inner = wrapped.result ?? stepOutput?.output ?? runResult;

  const result = inner as WorkflowResult;

  if (!result || typeof result !== "object" || !("mode" in result)) {
    console.error(
      "\n[family-canonical] FAILED: workflow returned unexpected shape",
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
      "\n[family-canonical] FAILED: aborted_due_to_cost=true — cost cap exceeded",
    );
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error("[family-canonical] FAILED:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await closeDriver();
    } catch (err) {
      console.error("[family-canonical] Failed to close Memgraph driver:", err);
    }
    // Force-exit because mastra/index.ts starts cron schedulers at module-import
    // time that keep the event loop alive.
    process.exit(process.exitCode ?? 0);
  });
