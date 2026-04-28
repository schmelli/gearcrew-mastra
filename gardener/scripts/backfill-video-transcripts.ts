/**
 * Backfill VideoSource.transcript_text for existing nodes that pre-date
 * the transcript-cache feature.
 *
 * For each VideoSource node missing transcript_text but having tubeonai_uuid:
 *   1. Re-fetch the transcript via TubeonAI getTranscription(uuid).
 *      TubeonAI caches transcripts by UUID — re-fetch is idempotent and
 *      typically reports `cached: true` (no extra credit cost).
 *   2. Write transcript_text + word_count + language back to the VideoSource.
 *
 * Usage:
 *   npx tsx scripts/backfill-video-transcripts.ts                 # process all
 *   npx tsx scripts/backfill-video-transcripts.ts --limit 10      # process first 10
 *   npx tsx scripts/backfill-video-transcripts.ts --dry-run       # show what would update
 */

import { getReadSession, getWriteSession } from "../src/lib/memgraph.js";
import { getTranscription } from "../src/tools/tubeonai.js";
import { sanitizeWebContent } from "../src/lib/utils.js";

interface CliArgs {
  limit?: number;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--limit") {
      const n = parseInt(argv[++i] ?? "", 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error("--limit requires a positive integer");
      }
      args.limit = n;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: npx tsx scripts/backfill-video-transcripts.ts [--limit N] [--dry-run]",
      );
      process.exit(0);
    }
  }
  return args;
}

interface CandidateRow {
  url: string;
  uuid: string;
  videoId: string;
  title: string;
}

async function fetchCandidates(limit?: number): Promise<CandidateRow[]> {
  const session = getReadSession();
  try {
    const cypher = `MATCH (v:VideoSource)
                    WHERE v.tubeonai_uuid IS NOT NULL
                      AND (v.transcript_text IS NULL OR v.transcript_text = '')
                    RETURN v.url AS url,
                           v.tubeonai_uuid AS uuid,
                           v.extracted_from_video_id AS videoId,
                           coalesce(v.title, '') AS title
                    ${limit ? `LIMIT ${limit}` : ""}`;
    const result = await session.run(cypher);
    return result.records.map((r) => ({
      url: String(r.get("url")),
      uuid: String(r.get("uuid")),
      videoId: String(r.get("videoId") ?? "?"),
      title: String(r.get("title") ?? ""),
    }));
  } finally {
    await session.close();
  }
}

async function writeTranscript(
  url: string,
  transcript: string,
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
           v.transcript_cached_at = datetime()`,
      { url, transcript, wordCount, language },
    );
  } finally {
    await session.close();
  }
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  console.log(
    `[backfill-transcripts] starting (limit=${cli.limit ?? "none"}, dryRun=${cli.dryRun})`,
  );

  const candidates = await fetchCandidates(cli.limit);
  console.log(
    `[backfill-transcripts] found ${candidates.length} VideoSource nodes missing transcript_text`,
  );

  if (candidates.length === 0) return;
  if (cli.dryRun) {
    console.log("[backfill-transcripts] DRY RUN — sample:");
    for (const c of candidates.slice(0, 5)) {
      console.log(`  ${c.videoId}  ${c.title.slice(0, 60)}`);
    }
    return;
  }

  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  let totalCredits = 0;

  for (let i = 0; i < candidates.length; i += 1) {
    const c = candidates[i];
    if (!c) continue;
    const tag = `[${i + 1}/${candidates.length}] ${c.videoId}`;
    try {
      const r = await getTranscription(c.uuid);
      if (r.status !== "completed" || !r.transcription) {
        console.warn(`${tag}: status=${r.status}, skipping`);
        skipped += 1;
        continue;
      }
      const sanitized = sanitizeWebContent(r.transcription);
      await writeTranscript(
        c.url,
        sanitized,
        r.wordCount ?? 0,
        r.language ?? "unknown",
      );
      totalCredits += r.creditsUsed;
      succeeded += 1;
      const cachedHint = r.cached ? "cached" : `${r.creditsUsed} credits`;
      console.log(
        `${tag}: cached transcript (${r.wordCount ?? 0} words, ${cachedHint})`,
      );
    } catch (err) {
      failed += 1;
      console.error(`${tag}: failed —`, err instanceof Error ? err.message : err);
    }
  }

  console.log(
    `[backfill-transcripts] done: succeeded=${succeeded}, failed=${failed}, skipped=${skipped}, totalCredits=${totalCredits}`,
  );
}

main().catch((err) => {
  console.error("[backfill-transcripts] fatal:", err);
  process.exit(1);
});
