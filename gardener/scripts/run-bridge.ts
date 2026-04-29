/**
 * CLI runner for the Supabase ↔ Memgraph Bridge workflow.
 *
 * Usage:
 *   npx tsx scripts/run-bridge.ts --mode dry-run [--limit N]
 *   npx tsx scripts/run-bridge.ts --mode apply   [--limit N]
 *
 * Exits 1 on workflow failure or unexpected output shape.
 */

import { mastra } from "../src/mastra/index.js";

interface CliArgs {
  mode?: "dry-run" | "apply";
  limit?: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--mode") {
      const next = argv[i + 1];
      if (next !== "dry-run" && next !== "apply") {
        throw new Error(`--mode must be "dry-run" or "apply", got: ${next}`);
      }
      args.mode = next;
      i += 1;
    } else if (arg === "--limit") {
      const next = argv[i + 1];
      const n = next ? parseInt(next, 10) : NaN;
      if (Number.isNaN(n) || n <= 0) {
        throw new Error("--limit requires a positive integer");
      }
      args.limit = n;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: npx tsx scripts/run-bridge.ts --mode dry-run|apply [--limit N]",
      );
      process.exit(0);
    }
  }
  return args;
}

interface BridgeResult {
  mode: "dry-run" | "apply";
  total_supabase_items: number;
  matched: number;
  unmatched: number;
  ambiguous: number;
  stamped: number;
  index_created: boolean;
  sample_unmatched: Array<{ brand: string; name: string }>;
  sample_ambiguous: Array<{ brand: string; name: string; match_count: number }>;
}

function printSummary(r: BridgeResult): void {
  console.log("\n=== BRIDGE SUMMARY ===");
  console.log(`Mode:            ${r.mode}`);
  console.log(`Total items:     ${r.total_supabase_items}`);
  console.log(
    `Matched:         ${r.matched} (${((r.matched / r.total_supabase_items) * 100).toFixed(1)}%)`,
  );
  console.log(`Unmatched:       ${r.unmatched}`);
  console.log(`Ambiguous:       ${r.ambiguous}`);
  if (r.mode === "apply") {
    console.log(`Stamped:         ${r.stamped}`);
    console.log(`Index created:   ${r.index_created}`);
  }

  if (r.sample_unmatched.length > 0) {
    console.log(`\n--- Sample unmatched (top ${r.sample_unmatched.length}) ---`);
    for (const s of r.sample_unmatched) {
      console.log(`  ${s.brand} / ${s.name}`);
    }
  }
  if (r.sample_ambiguous.length > 0) {
    console.log(`\n--- Sample ambiguous (top ${r.sample_ambiguous.length}) ---`);
    for (const s of r.sample_ambiguous) {
      console.log(`  ${s.brand} / ${s.name} (${s.match_count} matches)`);
    }
  }
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  if (!cli.mode) {
    console.error("ERROR: --mode is required (dry-run or apply)");
    process.exit(1);
  }

  console.log(
    `[bridge] starting workflow mode=${cli.mode} limit=${cli.limit ?? "none"}`,
  );

  const workflow = mastra.getWorkflow("supabaseMemgraphBridge");
  const run = await workflow.createRunAsync();
  const inputData: { mode: "dry-run" | "apply"; limit?: number } = {
    mode: cli.mode,
  };
  if (cli.limit !== undefined) inputData.limit = cli.limit;
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
    console.error(`\n[bridge] WORKFLOW FAILED: ${errMsg}`);
    process.exitCode = 1;
    return;
  }

  const stepOutput = wrapped.steps?.["match-and-stamp"] as
    | { output?: unknown }
    | undefined;
  const inner = wrapped.result ?? stepOutput?.output;
  const result = inner as BridgeResult | undefined;

  if (!result || typeof result !== "object" || !("matched" in result)) {
    console.error(
      "\n[bridge] FAILED: workflow returned unexpected shape",
      JSON.stringify(runResult).slice(0, 500),
    );
    process.exitCode = 1;
    return;
  }

  printSummary(result);
}

main()
  .catch((err) => {
    console.error("[bridge] FAILED:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    process.exit(process.exitCode ?? 0);
  });
