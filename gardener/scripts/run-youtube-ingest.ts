/**
 * CLI runner for the youtube-playlist-ingest workflow.
 *
 * Usage:
 *   npm run youtube:ingest -- --playlist <id> [--limit N] [--dry-run] [--force] [--max-credits N]
 *
 * Defaults to the canonical Gearshack outdoor-gear playlist when --playlist is omitted.
 */

import { mastra } from "../src/mastra/index.js";
import { closeDriver } from "../src/lib/memgraph.js";

interface CliArgs {
  playlistId?: string;
  limit?: number;
  dryRun: boolean;
  force: boolean;
  maxCredits?: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { dryRun: false, force: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--playlist": {
        const next = argv[i + 1];
        if (!next) throw new Error("--playlist requires a value");
        args.playlistId = next;
        i += 1;
        break;
      }
      case "--limit": {
        const next = argv[i + 1];
        const n = next ? parseInt(next, 10) : NaN;
        if (Number.isNaN(n) || n <= 0) throw new Error("--limit requires a positive integer");
        args.limit = n;
        i += 1;
        break;
      }
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--force":
        args.force = true;
        break;
      case "--max-credits": {
        const next = argv[i + 1];
        const n = next ? parseInt(next, 10) : NaN;
        if (Number.isNaN(n) || n <= 0) {
          throw new Error("--max-credits requires a positive integer");
        }
        args.maxCredits = n;
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

  return args;
}

function printHelpAndExit(code: number): never {
  const help = `Usage: npm run youtube:ingest -- [options]

Options:
  --playlist <id>       YouTube playlist id (default: built-in Gearshack playlist)
  --limit <N>           Process at most N videos (testing aid)
  --dry-run             Transcribe but skip GearGraph writes
  --force               Re-extract videos already at extraction_version=2
  --max-credits <N>     Stop after N TubeonAI credits used (safety cap)
  --help                Show this help`;
  console.log(help);
  process.exit(code);
}

const DEFAULT_PLAYLIST_ID = "PLy6TtegcnZj84nCIzqtZcWlNHD6sQAJqj";

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));

  // Mastra's `run.start({inputData})` does not apply zod schema `.default()` —
  // we must pass concrete values here. Optional fields stay omitted.
  const inputData: Record<string, unknown> = {
    playlistId: cli.playlistId ?? DEFAULT_PLAYLIST_ID,
    dryRun: cli.dryRun,
    force: cli.force,
  };
  if (cli.limit !== undefined) inputData.limit = cli.limit;
  if (cli.maxCredits !== undefined) inputData.maxCredits = cli.maxCredits;

  const workflow = mastra.getWorkflow("youtubePlaylistIngest");
  const run = await workflow.createRunAsync();
  const result = await run.start({ inputData });

  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((err) => {
    console.error("[youtube:ingest] FAILED:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await closeDriver();
    } catch (err) {
      console.error("[youtube:ingest] Failed to close Memgraph driver:", err);
    }
  });
