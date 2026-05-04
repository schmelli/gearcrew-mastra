/**
 * CLI runner for the urlIngest workflow.
 *
 * Usage:
 *   npx tsx scripts/run-url-ingest.ts --url <https-url> [--kind product|review|forum|auto]
 *
 * Exits non-zero on validation/scrape/extract failure so it is CI-safe.
 */

import { mastra } from "../src/mastra/index.js";
import { closeDriver } from "../src/lib/memgraph.js";

interface CliArgs {
  url: string;
  kind: "product" | "review" | "forum" | "auto";
}

function parseArgs(argv: string[]): CliArgs {
  let url: string | undefined;
  let kind: CliArgs["kind"] = "auto";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--url": {
        const next = argv[i + 1];
        if (!next) throw new Error("--url requires a value");
        url = next;
        i += 1;
        break;
      }
      case "--kind": {
        const next = argv[i + 1];
        if (!next) throw new Error("--kind requires a value");
        if (
          next !== "product" &&
          next !== "review" &&
          next !== "forum" &&
          next !== "auto"
        ) {
          throw new Error(
            `--kind must be one of product|review|forum|auto (got: ${next})`,
          );
        }
        kind = next;
        i += 1;
        break;
      }
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

  if (!url) {
    console.error("--url is required");
    printHelpAndExit(1);
  }

  return { url, kind };
}

function printHelpAndExit(code: number): never {
  const help = `Usage: npx tsx scripts/run-url-ingest.ts --url <url> [--kind <kind>]

Options:
  --url <https-url>     Target URL to ingest (HTTPS, public host only)
  --kind <kind>         Page kind hint: product | review | forum | auto (default: auto)
  --help                Show this help`;
  console.log(help);
  process.exit(code);
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));

  // Mastra's run.start({inputData}) does not apply zod schema .default() —
  // we pass concrete values explicitly.
  const inputData = { url: cli.url, kind: cli.kind };

  const workflow = mastra.getWorkflow("urlIngest");
  const run = await workflow.createRunAsync();
  const result = await run.start({ inputData });

  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((err) => {
    console.error("[url-ingest] FAILED:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await closeDriver();
    } catch (err) {
      console.error("[url-ingest] Failed to close Memgraph driver:", err);
    }
  });
