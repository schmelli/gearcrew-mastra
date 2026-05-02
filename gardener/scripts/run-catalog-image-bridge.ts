/**
 * CLI runner for the Catalog → Memgraph Image-Bridge workflow.
 *
 * Usage:
 *   npx tsx scripts/run-catalog-image-bridge.ts --mode dry-run [--limit N]
 *   npx tsx scripts/run-catalog-image-bridge.ts --mode apply   [--limit N]
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
        "Usage: npx tsx scripts/run-catalog-image-bridge.ts --mode dry-run|apply [--limit N]",
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
  image_url_filled: number;
  product_url_filled: number;
  index_created: boolean;
  sample_unmatched: Array<{ brand: string; name: string }>;
  sample_ambiguous: Array<{ brand: string; name: string; match_count: number }>;
}

function printSummary(r: BridgeResult): void {
  console.log("\n=== CATALOG-IMAGE-BRIDGE SUMMARY ===");
  console.log(`Mode:                  ${r.mode}`);
  console.log(`Total catalog items:   ${r.total_supabase_items}`);
  console.log(
    `Matched:               ${r.matched} (${((r.matched / r.total_supabase_items) * 100).toFixed(1)}%)`,
  );
  console.log(`Unmatched:             ${r.unmatched}`);
  console.log(`Ambiguous:             ${r.ambiguous}`);
  if (r.mode === "apply") {
    console.log(`Stamped (total):       ${r.stamped}`);
    console.log(`  image_url filled:    ${r.image_url_filled}`);
    console.log(`  product_url filled:  ${r.product_url_filled}`);
    console.log(`Index ready:           ${r.index_created}`);
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
    `[catalog-image-bridge] starting workflow mode=${cli.mode} limit=${cli.limit ?? "none"}`,
  );

  const workflow = mastra.getWorkflow("catalogImageBridge");
  const run = await workflow.createRunAsync();
  const inputData: { mode: "dry-run" | "apply"; limit?: number } = {
    mode: cli.mode,
  };
  if (cli.limit !== undefined) inputData.limit = cli.limit;

  const result = await run.start({ inputData });

  if (result.status !== "success") {
    console.error("Workflow did not complete successfully:", result);
    process.exit(1);
  }

  const output = (result as { result: BridgeResult }).result;
  printSummary(output);

  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
