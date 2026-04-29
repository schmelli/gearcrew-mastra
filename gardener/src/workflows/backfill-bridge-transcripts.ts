/**
 * Backfill transcripts for VideoSources linked to BRIDGED GearItems.
 *
 * Mastra workflow form of scripts/backfill-bridge-transcripts.ts —
 * triggerable via the gardener API since the production container
 * doesn't include source files for tsx execution.
 *
 * Filters Memgraph VideoSources where:
 *   - linked to a GearItem with supabase_id IS NOT NULL (bridged)
 *   - transcript_text IS NULL OR size(transcript_text) < 500
 *
 * For each, calls TubeonAI createTranscription(url) — idempotent on URL,
 * caches in TubeonAI's account so re-fetches are typically 0 credits.
 */

import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { getReadSession, getWriteSession } from "../lib/memgraph.js";
import {
  createTranscription,
  waitForCompletion,
} from "../tools/tubeonai.js";
import { sanitizeWebContent } from "../lib/utils.js";

const triggerSchema = z.object({
  limit: z.number().int().positive().optional(),
  dryRun: z.boolean().default(false),
});

const sampleSchema = z.object({
  url: z.string(),
  title: z.string(),
  itemBrand: z.string(),
  itemName: z.string(),
});

const outputSchema = z.object({
  total_targets: z.number(),
  succeeded: z.number(),
  failed: z.number(),
  skipped: z.number(),
  total_credits: z.number(),
  dry_run: z.boolean(),
  sample_targets: z.array(sampleSchema),
});

interface TargetVideo {
  url: string;
  title: string;
  itemBrand: string;
  itemName: string;
}

const backfillStep = createStep({
  id: "backfill-bridge-transcripts",
  description:
    "Fetch transcripts via TubeonAI for VideoSources linked to bridged GearItems",
  inputSchema: triggerSchema,
  outputSchema,
  async execute({ inputData }) {
    // 1. Fetch targets from Memgraph
    const readSess = getReadSession();
    let targets: TargetVideo[];
    try {
      const result = await readSess.run(
        `MATCH (g:GearItem)-[:EXTRACTED_FROM]->(v:VideoSource)
         WHERE g.supabase_id IS NOT NULL
           AND (v.transcript_text IS NULL OR size(v.transcript_text) < 500)
         RETURN DISTINCT v.url AS url,
                coalesce(v.title, '(no title)') AS title,
                g.brand AS itemBrand,
                g.name AS itemName
         ORDER BY url
         ${inputData.limit ? `LIMIT ${inputData.limit}` : ""}`,
      );
      targets = result.records.map((r) => ({
        url: String(r.get("url")),
        title: String(r.get("title")),
        itemBrand: String(r.get("itemBrand") ?? "?"),
        itemName: String(r.get("itemName") ?? "?"),
      }));
    } finally {
      await readSess.close();
    }

    console.log(
      `[backfill-bridge] ${targets.length} targets, dryRun=${inputData.dryRun}`,
    );

    if (inputData.dryRun || targets.length === 0) {
      return {
        total_targets: targets.length,
        succeeded: 0,
        failed: 0,
        skipped: 0,
        total_credits: 0,
        dry_run: inputData.dryRun,
        sample_targets: targets.slice(0, 20),
      };
    }

    // 2. Fetch + write each transcript
    let succeeded = 0;
    let failed = 0;
    let skipped = 0;
    let totalCredits = 0;

    for (let i = 0; i < targets.length; i += 1) {
      const t = targets[i]!;
      const tag = `[${i + 1}/${targets.length}] ${t.itemBrand}/${t.itemName.slice(0, 25)}`;
      try {
        let r = await createTranscription(t.url);
        if (r.status !== "completed") {
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

        const writeSess = getWriteSession();
        try {
          await writeSess.run(
            `MATCH (v:VideoSource {url: $url})
             SET v.transcript_text = $transcript,
                 v.transcript_word_count = $wordCount,
                 v.transcript_language = $language,
                 v.tubeonai_uuid = $uuid,
                 v.transcript_cached_at = datetime()`,
            {
              url: t.url,
              transcript: sanitized,
              wordCount: r.wordCount ?? 0,
              language: r.language ?? "unknown",
              uuid: r.uuid,
            },
          );
        } finally {
          await writeSess.close();
        }

        totalCredits += r.creditsUsed;
        succeeded += 1;
        const cachedHint = r.cached ? "cached" : `${r.creditsUsed} credits`;
        console.log(`${tag}: ✓ ${r.wordCount ?? 0}w (${cachedHint})`);
      } catch (err) {
        failed += 1;
        console.error(
          `${tag}: ✗`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    console.log(
      `[backfill-bridge] done succeeded=${succeeded} failed=${failed} skipped=${skipped} credits=${totalCredits}`,
    );

    return {
      total_targets: targets.length,
      succeeded,
      failed,
      skipped,
      total_credits: totalCredits,
      dry_run: false,
      sample_targets: targets.slice(0, 20),
    };
  },
});

export const backfillBridgeTranscripts = createWorkflow({
  id: "backfillBridgeTranscripts",
  inputSchema: triggerSchema,
  outputSchema,
})
  .then(backfillStep)
  .commit();
