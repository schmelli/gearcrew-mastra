/**
 * Backfill transcripts for VideoSources linked to BRIDGED GearItems.
 *
 * Phase C v1 prep: only bridged GearItems (g.supabase_id IS NOT NULL) can
 * receive insights — so we only need transcripts for the videos those items
 * were extracted from.
 *
 * Different from backfill-video-transcripts.ts:
 *  - That script only runs on videos with existing tubeonai_uuid (~0 hits).
 *  - This script runs on URL via createTranscription() — works on the older
 *    910 VideoSources that pre-date the transcript-cache feature.
 *
 * Usage:
 *   npx tsx scripts/backfill-bridge-transcripts.ts            # all bridged
 *   npx tsx scripts/backfill-bridge-transcripts.ts --limit 5  # first 5
 *   npx tsx scripts/backfill-bridge-transcripts.ts --dry-run  # show targets
 */

import { getReadSession, getWriteSession } from "../src/lib/memgraph.js";
import {
  createTranscription,
  waitForCompletion,
} from "../src/tools/tubeonai.js";
import { sanitizeWebContent } from "../src/lib/utils.js";

interface CliArgs {
  limit?: number;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--limit") {
      const n = parseInt(argv[++i] ?? "", 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error("--limit requires a positive integer");
      }
      args.limit = n;
    } else if (a === "--dry-run") {
      args.dryRun = true;
    } else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: npx tsx scripts/backfill-bridge-transcripts.ts [--limit N] [--dry-run]",
      );
      process.exit(0);
    }
  }
  return args;
}

interface TargetVideo {
  url: string;
  title: string;
  itemBrand: string;
  itemName: string;
}

async function fetchTargets(limit?: number): Promise<TargetVideo[]> {
  const session = getReadSession();
  try {
    const result = await session.run(
      `MATCH (g:GearItem)-[:EXTRACTED_FROM]->(v:VideoSource)
       WHERE g.supabase_id IS NOT NULL
         AND (v.transcript_text IS NULL OR size(v.transcript_text) < 500)
       RETURN DISTINCT v.url AS url,
              coalesce(v.title, '(no title)') AS title,
              g.brand AS itemBrand,
              g.name AS itemName
       ORDER BY url
       ${limit ? `LIMIT ${limit}` : ""}`,
    );
    return result.records.map((r) => ({
      url: String(r.get("url")),
      title: String(r.get("title")),
      itemBrand: String(r.get("itemBrand") ?? "?"),
      itemName: String(r.get("itemName") ?? "?"),
    }));
  } finally {
    await session.close();
  }
}

async function writeTranscript(
  url: string,
  transcript: string,
  uuid: string,
  wordCount: number,
  language: string,
): Promise<void> {
  const session = getWriteSession();
  try {
    await session.run(
      `MATCH (v:VideoSource {url: $url})
       SET v.transcript_text = $transcript,
           v.transcript_word_count = $wordCount,
           v.transcript_language = $language,
           v.tubeonai_uuid = $uuid,
           v.transcript_cached_at = datetime()`,
      { url, transcript, uuid, wordCount, language },
    );
  } finally {
    await session.close();
  }
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  console.log(
    `[backfill-bridge] starting limit=${cli.limit ?? "all"} dryRun=${cli.dryRun}`,
  );

  const targets = await fetchTargets(cli.limit);
  console.log(
    `[backfill-bridge] ${targets.length} VideoSources need transcript (linked to bridged items)`,
  );

  if (targets.length === 0) return;
  if (cli.dryRun) {
    console.log("[backfill-bridge] DRY RUN — sample (first 10):");
    for (const t of targets.slice(0, 10)) {
      console.log(
        `  ${t.itemBrand} | ${t.itemName.slice(0, 30).padEnd(30)}  ${t.title.slice(0, 60)}`,
      );
    }
    return;
  }

  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  let totalCredits = 0;

  for (let i = 0; i < targets.length; i += 1) {
    const t = targets[i]!;
    const tag = `[${i + 1}/${targets.length}] ${t.itemBrand}/${t.itemName.slice(0, 25)}`;
    try {
      // Create-or-fetch transcription job (idempotent on URL)
      let r = await createTranscription(t.url);
      if (r.status !== "completed") {
        // Poll up to default timeout (30 min)
        r = await waitForCompletion(r.uuid);
      }
      if (r.status !== "completed" || !r.transcription) {
        console.warn(
          `${tag}: status=${r.status} ${r.error ?? ""} — skipping`,
        );
        skipped += 1;
        continue;
      }
      const sanitized = sanitizeWebContent(r.transcription);
      await writeTranscript(
        t.url,
        sanitized,
        r.uuid,
        r.wordCount ?? 0,
        r.language ?? "unknown",
      );
      totalCredits += r.creditsUsed;
      succeeded += 1;
      const cachedHint = r.cached ? "cached" : `${r.creditsUsed} credits`;
      console.log(
        `${tag}: ✓ ${r.wordCount ?? 0}w (${cachedHint})`,
      );
    } catch (err) {
      failed += 1;
      console.error(
        `${tag}: ✗`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  console.log(
    `\n[backfill-bridge] done: succeeded=${succeeded}, failed=${failed}, skipped=${skipped}, totalCredits=${totalCredits}`,
  );
}

main()
  .catch((err) => {
    console.error("[backfill-bridge] fatal:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    process.exit(process.exitCode ?? 0);
  });
