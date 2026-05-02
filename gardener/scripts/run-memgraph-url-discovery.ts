/**
 * CLI runner for memgraphUrlDiscovery workflow.
 *
 * Usage:
 *   npx tsx scripts/run-memgraph-url-discovery.ts --mode dry-run [--limit N]
 *   npx tsx scripts/run-memgraph-url-discovery.ts --mode apply   [--limit N] [--max-cost-credits N]
 */

import { mastra } from "../src/mastra/index.js";

interface CliArgs {
  mode?: "dry-run" | "apply";
  limit?: number;
  concurrency?: number;
  maxCostCredits?: number;
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
      if (Number.isNaN(n) || n <= 0) throw new Error("--limit must be positive int");
      args.limit = n;
      i += 1;
    } else if (arg === "--concurrency") {
      const next = argv[i + 1];
      const n = next ? parseInt(next, 10) : NaN;
      if (Number.isNaN(n) || n <= 0) throw new Error("--concurrency must be positive int");
      args.concurrency = n;
      i += 1;
    } else if (arg === "--max-cost-credits") {
      const next = argv[i + 1];
      const n = next ? parseInt(next, 10) : NaN;
      if (Number.isNaN(n) || n <= 0) throw new Error("--max-cost-credits must be positive int");
      args.maxCostCredits = n;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: npx tsx scripts/run-memgraph-url-discovery.ts --mode dry-run|apply [--limit N] [--concurrency N] [--max-cost-credits N]",
      );
      process.exit(0);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  if (!cli.mode) {
    console.error("ERROR: --mode is required (dry-run or apply)");
    process.exit(1);
  }

  const workflow = mastra.getWorkflow("memgraphUrlDiscovery");
  const run = await workflow.createRunAsync();
  const inputData: {
    mode: "dry-run" | "apply";
    limit?: number;
    concurrency?: number;
    max_cost_credits?: number;
  } = { mode: cli.mode };
  if (cli.limit !== undefined) inputData.limit = cli.limit;
  if (cli.concurrency !== undefined) inputData.concurrency = cli.concurrency;
  if (cli.maxCostCredits !== undefined) inputData.max_cost_credits = cli.maxCostCredits;

  const result = await run.start({ inputData });

  if (result.status !== "success") {
    console.error("Workflow did not complete successfully:", result);
    process.exit(1);
  }

  const output = (result as { result: unknown }).result;
  console.log("\n=== MEMGRAPH-URL-DISCOVERY SUMMARY ===");
  console.log(JSON.stringify(output, null, 2));

  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
