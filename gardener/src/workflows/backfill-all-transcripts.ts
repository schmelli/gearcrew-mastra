/**
 * Backfill transcripts for ALL VideoSources linked to ANY GearItem.
 *
 * Companion to backfill-bridge-transcripts.ts which only targets bridged
 * GearItems (g.supabase_id IS NOT NULL). This workflow widens the net to all
 * GearItems with EXTRACTED_FROM edges so the Memgraph-only items (~2,467) can
 * receive insights too.
 *
 * Filters Memgraph VideoSources where:
 *   - linked to ANY GearItem via :EXTRACTED_FROM
 *   - transcript_text IS NULL OR size(transcript_text) < 500
 *
 * For each, calls TubeonAI createTranscription(url) — idempotent on URL,
 * cached by TubeonAI account so re-fetches typically cost 0 credits.
 *
 * Cost cap: Aborts when total_credits >= max_cost_cents (1 credit ~= 1 cent).
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
  maxCostCents: z.number().int().positive().default(5000),
});

const sampleSchema = z.object({
  url: z.string(),
  title: z.string(),
  linked_items: z.number(),
});

const outputSchema = z.object({
  total_targets: z.number(),
  succeeded: z.number(),
  failed: z.number(),
  skipped: z.number(),
  total_credits: z.number(),
  aborted_cost_cap: z.boolean(),
  dry_run: z.boolean(),
  sample_targets: z.array(sampleSchema),
});

interface TargetVideo {
  url: string;
  title: string;
  linkedItems: number;
}

const backfillStep = createStep({
  id: "backfill-all-transcripts",
  description:
    "Fetch transcripts via TubeonAI for ALL VideoSources linked to any GearItem (super-set of bridge-only)",
  inputSchema: triggerSchema,
  outputSchema,
  async execute({ inputData }) {
    // 1. Fetch all candidate VideoSources from Memgraph.
    //    Memgraph LIMIT does not accept parameter substitution — inline literal.
    const limitClause = inputData.limit ? `LIMIT ${inputData.limit}` : "";
    const readSess = getReadSession();
    let targets: TargetVideo[];
    try {
      const result = await readSess.run(
        `MATCH (g:GearItem)-[:EXTRACTED_FROM]->(v:VideoSource)
         WHERE v.transcript_text IS NULL OR size(v.transcript_text) < 500
         WITH v, count(DISTINCT g) AS linked_items
         RETURN v.url AS url,
                coalesce(v.title, '(no title)') AS title,
                linked_items
         ORDER BY linked_items DESC, url
         ${limitClause}`,
      );
      targets = result.records.map((r) => ({
        url: String(r.get("url")),
        title: String(r.get("title")),
        linkedItems: Number(r.get("linked_items") ?? 0),
      }));
    } finally {
      await readSess.close();
    }

    console.log(
      `[backfill-all] ${targets.length} targets, dryRun=${inputData.dryRun}, maxCostCents=${inputData.maxCostCents}`,
    );

    if (inputData.dryRun || targets.length === 0) {
      return {
        total_targets: targets.length,
        succeeded: 0,
        failed: 0,
        skipped: 0,
        total_credits: 0,
        aborted_cost_cap: false,
        dry_run: inputData.dryRun,
        sample_targets: targets.slice(0, 20).map((t) => ({
          url: t.url,
          title: t.title,
          linked_items: t.linkedItems,
        })),
      };
    }

    // 2. Fetch + write each transcript with cost-cap abort.
    let succeeded = 0;
    let failed = 0;
    let skipped = 0;
    let totalCredits = 0;
    let abortedCostCap = false;

    for (let i = 0; i < targets.length; i += 1) {
      if (totalCredits >= inputData.maxCostCents) {
        console.warn(
          `[backfill-all] cost-cap hit (${totalCredits} >= ${inputData.maxCostCents}) — aborting at item ${i + 1}/${targets.length}`,
        );
        abortedCostCap = true;
        break;
      }

      const t = targets[i]!;
      const tag = `[${i + 1}/${targets.length}] ${t.title.slice(0, 40)}`;
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
        console.log(
          `${tag}: ✓ ${r.wordCount ?? 0}w (${cachedHint}) [${t.linkedItems} items]`,
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
      `[backfill-all] done succeeded=${succeeded} failed=${failed} skipped=${skipped} credits=${totalCredits} aborted_cost_cap=${abortedCostCap}`,
    );

    return {
      total_targets: targets.length,
      succeeded,
      failed,
      skipped,
      total_credits: totalCredits,
      aborted_cost_cap: abortedCostCap,
      dry_run: false,
      sample_targets: targets.slice(0, 20).map((t) => ({
        url: t.url,
        title: t.title,
        linked_items: t.linkedItems,
      })),
    };
  },
});

export const backfillAllTranscripts = createWorkflow({
  id: "backfillAllTranscripts",
  inputSchema: triggerSchema,
  outputSchema,
})
  .then(backfillStep)
  .commit();
