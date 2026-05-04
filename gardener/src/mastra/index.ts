import { Mastra } from "@mastra/core/mastra";
import cron, { type ScheduledTask } from "node-cron";
import { gardenerHaiku, gardenerSonnet } from "../agents/gardener-v3.js";
import { youtubeGearExtractor } from "../agents/youtube-gear-extractor.js";
import { brandPortfolioAudit } from "../workflows/brand-portfolio-audit.js";
import { youtubePlaylistIngest } from "../workflows/youtube-playlist-ingest.js";
import { brandDedup } from "../workflows/brand-dedup.js";
import { typeDedup } from "../workflows/type-dedup.js";
import { successorDetection } from "../workflows/successor-detection.js";
import { specNormalization } from "../workflows/spec-normalization.js";
import { supabaseMemgraphBridge } from "../workflows/supabase-memgraph-bridge.js";
import { backfillBridgeTranscripts } from "../workflows/backfill-bridge-transcripts.js";
import { backfillAllTranscripts } from "../workflows/backfill-all-transcripts.js";
import { tipClassification } from "../workflows/tip-classification.js";
import { insightMigration } from "../workflows/insight-migration.js";
import { rerouteFallbackTips } from "../workflows/reroute-fallback-tips.js";
import { familyCanonical } from "../workflows/family-canonical-names.js";
import { catalogImageBridge } from "../workflows/catalog-image-bridge.js";
// memgraphImageScrape + memgraphUrlDiscovery: kept registered so the
// scripts/run-memgraph-{image-scrape,url-discovery}.ts CLI runners still
// work — but the cron schedulers below are gone (Klebefalle work is now
// done by gardenerSweeper + gardenerEnrichmentCycle).
import { memgraphImageScrape } from "../workflows/memgraph-image-scrape.js";
import { memgraphUrlDiscovery } from "../workflows/memgraph-url-discovery.js";
import { brandPriorityBootstrap } from "../workflows/brand-priority-bootstrap.js";
import { gardenerSweeper } from "../workflows/gardener-sweeper.js";
import { gardenerEnrichmentCycle } from "../workflows/gardener-enrichment-cycle.js";
import { closeDriver } from "../lib/memgraph.js";

// DEREGISTERED 2026-05-03 (Source-of-Truth cleanup):
//   - autoTypingFlash         (./workflows/auto-typing.ts)
//   - enrichmentLite          (./workflows/enrichment-lite.ts)
//   - enrichmentPremium       (./workflows/enrichment-premium.ts)
// These workflows wrote enrichment results back into Supabase `gear_items`,
// violating the rule that GearGraph (Memgraph) is the single source of truth
// for gear data. Files are still on disk for reference until deletion is
// confirmed; importers and exports above are removed so they cannot run.

const port = parseInt(process.env.PORT || "4111", 10);

export const mastra = new Mastra({
  agents: {
    GardenerHaiku: gardenerHaiku,
    GardenerSonnet: gardenerSonnet,
    YoutubeGearExtractor: youtubeGearExtractor,
  },
  // SoT-Rule (2026-05-03 onwards): GearGraph (Memgraph) is the single source
  // of truth for gear data. Workflows registered here may only:
  //   - read from Supabase to enrich Memgraph (catalog-image-bridge,
  //     supabase-memgraph-bridge — both write Memgraph only)
  //   - read/write Memgraph directly (memgraph-* family)
  //   - persist run telemetry / admin queues to Supabase
  //     (gardener_workflow_runs, brand_dedup_queue, family_canonical_queue,
  //      processed_videos, graph_audit_log)
  // Workflows that wrote enrichment results back into Supabase gear_items
  // (enrichmentLite, enrichmentPremium, autoTypingFlash) were deregistered.
  //
  // brandDedup / familyCanonical: Admin-Queue producers — write only to a
  // human-review queue, never apply changes themselves.
  // typeDedup: read-only catalog dedup proposals (apply happens via migration).
  // catalogImageBridge / supabaseMemgraphBridge: Supabase → Memgraph spiegel,
  // niemals umgekehrt; nicht-clobbernd (nur wenn Memgraph-Feld NULL).
  workflows: {
    brandPortfolioAudit,
    youtubePlaylistIngest,
    brandDedup,
    typeDedup,
    successorDetection,
    specNormalization,
    supabaseMemgraphBridge,
    backfillBridgeTranscripts,
    backfillAllTranscripts,
    tipClassification,
    insightMigration,
    rerouteFallbackTips,
    familyCanonical,
    catalogImageBridge,
    memgraphImageScrape,
    memgraphUrlDiscovery,
    brandPriorityBootstrap,
    gardenerSweeper,
    gardenerEnrichmentCycle,
  },
  server: {
    port,
    // Long timeout to support multi-batch workflows (tip-classification:
    // 9525 tips × 50/batch = 191 batches × ~3s ≈ 10 min). Default 5 min was
    // too tight. 30 min covers worst-case batch retries.
    timeout: process.env.NODE_ENV === "production" ? 1800000 : 600000,
  },
});

// ---------------------------------------------------------------------------
// Autonomous Scheduler — runs brand-category scans every 10 minutes
// If a scan returns "skipped", immediately retries with the next brand (up to MAX_RETRIES)
// ---------------------------------------------------------------------------

const MAX_SKIP_RETRIES = 10; // try up to 10 brands per tick before giving up

let scanTask: ScheduledTask | null = null;
let isRunning = false;
let consecutiveErrors = 0;
let pausedUntil = 0;

async function runScanCycle(): Promise<void> {
  // Check if scheduler is paused (e.g. after API billing errors)
  if (Date.now() < pausedUntil) {
    const remainingMin = Math.round((pausedUntil - Date.now()) / 60_000);
    console.log(`[Gardener v3] Paused for ${remainingMin} more minutes (billing/rate limit cooldown)`);
    return;
  }

  const workflow = mastra.getWorkflow("brandPortfolioAudit");

  for (let attempt = 1; attempt <= MAX_SKIP_RETRIES; attempt++) {
    const runStart = Date.now();
    const run = await workflow.createRunAsync();
    const result = await run.start({ inputData: {} });

    // Extract outcome from the nested workflow result
    const steps = (result as Record<string, unknown>).steps as Record<string, unknown> | undefined;
    const writeReportStep = steps?.["write-report"] as Record<string, unknown> | undefined;
    const output = writeReportStep?.output as Record<string, unknown> | undefined;
    const outcome = output?.outcome as string | undefined;
    const brandName = output?.brandName as string | undefined;
    const categoryName = output?.categoryName as string | undefined;

    const duration = Math.round((Date.now() - runStart) / 1000);

    if (outcome === "skipped") {
      console.log(`[Gardener v3] Skipped: ${brandName || "?"} (${duration}s) — trying next brand (${attempt}/${MAX_SKIP_RETRIES})`);
      consecutiveErrors = 0;
      continue;
    }

    if (outcome === "error") {
      consecutiveErrors++;
      console.error(`[Gardener v3] Error: ${brandName || "?"}/${categoryName || "?"} (${duration}s) — consecutive errors: ${consecutiveErrors}`);

      if (consecutiveErrors >= 3) {
        // 3+ errors in a row → likely a billing/rate-limit issue, pause for 30 minutes
        pausedUntil = Date.now() + 30 * 60_000;
        console.error(`[Gardener v3] PAUSING for 30 minutes after ${consecutiveErrors} consecutive errors`);
        consecutiveErrors = 0;
      }
      return; // stop this tick, try again next tick (or after pause)
    }

    // completed — reset error counter
    consecutiveErrors = 0;
    console.log(`[Gardener v3] ${outcome}: ${brandName || "?"}/${categoryName || "?"} (${duration}s)`);
    return;
  }

  console.log(`[Gardener v3] Skipped ${MAX_SKIP_RETRIES} brands in a row — waiting for next tick`);
}

function startScheduler(): void {
  const schedule = process.env.GARDENER_SCAN_SCHEDULE || "*/10 * * * *";
  const enabled = process.env.GARDENER_AUTONOMOUS !== "false";

  if (!enabled) {
    console.log("[Gardener v3] Autonomous mode disabled (GARDENER_AUTONOMOUS=false)");
    return;
  }

  scanTask = cron.schedule(schedule, async () => {
    if (isRunning) {
      console.log("[Gardener v3] Previous scan still running, skipping this tick");
      return;
    }

    isRunning = true;
    const tickStart = Date.now();

    try {
      await runScanCycle();
    } catch (err) {
      const duration = Math.round((Date.now() - tickStart) / 1000);
      console.error(`[Gardener v3] Scan failed (${duration}s):`, err);
    } finally {
      isRunning = false;
    }
  }, { timezone: "UTC" });

  console.log(`[Gardener v3] Scheduler started: "${schedule}" (UTC)`);
}

// Start scheduler after a short delay to let Mastra finish initialization
setTimeout(() => startScheduler(), 5000);

// ---------------------------------------------------------------------------
// YouTube Playlist Incremental Ingest Scheduler
// Runs the youtubePlaylistIngest workflow on a separate cron, default daily 03:00 UTC.
// Skips already-completed videos via Supabase processed_videos filter — so only
// truly new playlist additions are processed.
// Disable via YOUTUBE_INGEST_AUTONOMOUS=false. Override schedule via YOUTUBE_INGEST_SCHEDULE.
// ---------------------------------------------------------------------------

let youtubeTask: ScheduledTask | null = null;
let youtubeIsRunning = false;

async function runYoutubeIncrementalCycle(): Promise<void> {
  const workflow = mastra.getWorkflow("youtubePlaylistIngest");
  const playlistId =
    process.env.YOUTUBE_PLAYLIST_ID || "PLy6TtegcnZj84nCIzqtZcWlNHD6sQAJqj";

  const start = Date.now();
  const run = await workflow.createRunAsync();
  const result = await run.start({
    inputData: {
      playlistId,
      dryRun: false,
      force: false,
    },
  });

  const seconds = Math.round((Date.now() - start) / 1000);
  const stepResult = (result as { result?: Record<string, unknown> }).result ?? {};
  const succeeded = stepResult.succeeded ?? "?";
  const failed = stepResult.failed ?? "?";
  const skipped = stepResult.skipped ?? "?";
  console.log(
    `[YouTube-Cron] cycle done in ${seconds}s — succeeded=${succeeded}, failed=${failed}, skipped=${skipped}`,
  );
}

function startYoutubeScheduler(): void {
  const schedule = process.env.YOUTUBE_INGEST_SCHEDULE || "0 3 * * *"; // 03:00 UTC daily
  const enabled = process.env.YOUTUBE_INGEST_AUTONOMOUS !== "false";

  if (!enabled) {
    console.log("[YouTube-Cron] Autonomous mode disabled (YOUTUBE_INGEST_AUTONOMOUS=false)");
    return;
  }

  youtubeTask = cron.schedule(
    schedule,
    async () => {
      if (youtubeIsRunning) {
        console.log("[YouTube-Cron] Previous cycle still running, skipping this tick");
        return;
      }
      youtubeIsRunning = true;
      const tickStart = Date.now();
      try {
        await runYoutubeIncrementalCycle();
      } catch (err) {
        const duration = Math.round((Date.now() - tickStart) / 1000);
        console.error(`[YouTube-Cron] Cycle failed (${duration}s):`, err);
      } finally {
        youtubeIsRunning = false;
      }
    },
    { timezone: "UTC" },
  );

  console.log(`[YouTube-Cron] Scheduler started: "${schedule}" (UTC)`);
}

setTimeout(() => startYoutubeScheduler(), 7000);

// ---------------------------------------------------------------------------
// Klebefalle-Aufwertung Schedulers (memgraphUrlDiscovery + memgraphImageScrape)
// were removed 2026-05-04 (Phase 4.2). Their work is now subsumed by
// gardenerSweeper (which queues GearItems with missing product_url /
// image_url) plus gardenerEnrichmentCycle (which fills those gaps via the
// Gardener-Haiku agent — itself uses the same Serper + og:image tools).
//
// The workflows themselves stay registered above so the manual CLI runners
// scripts/run-memgraph-{url-discovery,image-scrape}.ts continue to work
// for one-off backfills or debugging.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Gardener-Sweeper Scheduler (Phase 1 of 3-layer Gardener architecture)
//
// Hourly run that identifies :GearItem nodes with enrichment gaps and writes
// them into Supabase gardener_work_queue. The Phase-2 enrichment-cycle (next
// commit) reads top-N from that queue and dispatches to the Gardener-Haiku
// agent for autonomous gap-filling.
//
// Toggle via SWEEPER_AUTONOMOUS=false. Override schedule via SWEEPER_SCHEDULE.
// ---------------------------------------------------------------------------

let sweeperTask: ScheduledTask | null = null;
let sweeperRunning = false;

async function runSweeperCycle(): Promise<void> {
  const workflow = mastra.getWorkflow("gardenerSweeper");
  const start = Date.now();
  const run = await workflow.createRunAsync();
  const result = await run.start({ inputData: {} });
  const seconds = Math.round((Date.now() - start) / 1000);
  const stepResult =
    (result as { result?: Record<string, unknown> }).result ?? {};
  console.log(
    `[Gardener-Sweeper] cycle done in ${seconds}s — candidates=${stepResult.candidates_found ?? "?"} inserted=${stepResult.queue_inserted ?? "?"} refreshed=${stepResult.queue_refreshed ?? "?"} resolved=${stepResult.queue_resolved ?? "?"}`,
  );
}

function startSweeperScheduler(): void {
  const schedule = process.env.SWEEPER_SCHEDULE || "0 * * * *"; // every hour at :00
  const enabled = process.env.SWEEPER_AUTONOMOUS !== "false";
  if (!enabled) {
    console.log("[Gardener-Sweeper] Disabled (SWEEPER_AUTONOMOUS=false)");
    return;
  }
  sweeperTask = cron.schedule(
    schedule,
    async () => {
      if (sweeperRunning) {
        console.log("[Gardener-Sweeper] Previous cycle still running, skipping");
        return;
      }
      sweeperRunning = true;
      try {
        await runSweeperCycle();
      } catch (err) {
        console.error("[Gardener-Sweeper] Cycle failed:", err);
      } finally {
        sweeperRunning = false;
      }
    },
    { timezone: "UTC" },
  );
  console.log(`[Gardener-Sweeper] Scheduler started: "${schedule}" (UTC)`);
}

setTimeout(() => startSweeperScheduler(), 11000);

// ---------------------------------------------------------------------------
// Gardener-Enrichment-Cycle Scheduler (Phase 2 of 3-layer architecture)
//
// Hourly cycle that claims top-N items from gardener_work_queue and dispatches
// each to the GardenerHaiku agent for autonomous gap-filling. Schedule is
// offset by 30 minutes from the Sweeper so each cycle works on a freshly
// updated queue.
//
// Defaults: maxItems=8, maxCostUsd=2 → 24 cycles/day × $2 cap = max $48/day.
// Toggle via CYCLE_AUTONOMOUS=false. Override schedule via CYCLE_SCHEDULE.
// ---------------------------------------------------------------------------

let cycleTask: ScheduledTask | null = null;
let cycleRunning = false;

async function runEnrichmentCycle(): Promise<void> {
  const workflow = mastra.getWorkflow("gardenerEnrichmentCycle");
  const start = Date.now();
  const run = await workflow.createRunAsync();
  const result = await run.start({
    inputData: {
      maxItems: parseInt(process.env.CYCLE_MAX_ITEMS ?? "8", 10),
      maxCostUsd: parseFloat(process.env.CYCLE_MAX_COST_USD ?? "2"),
    },
  });
  const seconds = Math.round((Date.now() - start) / 1000);
  const stepResult =
    (result as { result?: Record<string, unknown> }).result ?? {};
  console.log(
    `[Gardener-Cycle] cycle done in ${seconds}s — claimed=${stepResult.items_claimed ?? "?"} done=${stepResult.items_done ?? "?"} failed=${stepResult.items_failed ?? "?"} cost_cents=${stepResult.total_cost_cents ?? "?"} aborted_cap=${stepResult.aborted_cost_cap ?? "?"}`,
  );
}

function startCycleScheduler(): void {
  const schedule = process.env.CYCLE_SCHEDULE || "30 * * * *"; // every hour at :30
  const enabled = process.env.CYCLE_AUTONOMOUS !== "false";
  if (!enabled) {
    console.log("[Gardener-Cycle] Disabled (CYCLE_AUTONOMOUS=false)");
    return;
  }
  cycleTask = cron.schedule(
    schedule,
    async () => {
      if (cycleRunning) {
        console.log("[Gardener-Cycle] Previous cycle still running, skipping");
        return;
      }
      cycleRunning = true;
      try {
        await runEnrichmentCycle();
      } catch (err) {
        console.error("[Gardener-Cycle] Cycle failed:", err);
      } finally {
        cycleRunning = false;
      }
    },
    { timezone: "UTC" },
  );
  console.log(`[Gardener-Cycle] Scheduler started: "${schedule}" (UTC)`);
}

setTimeout(() => startCycleScheduler(), 13000);

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function gracefulShutdown(signal: string) {
  console.log(`[Gardener v3] Received ${signal}, shutting down...`);
  if (scanTask) {
    scanTask.stop();
    console.log("[Gardener v3] Scheduler stopped");
  }
  if (youtubeTask) {
    youtubeTask.stop();
    console.log("[YouTube-Cron] Scheduler stopped");
  }
  if (sweeperTask) {
    sweeperTask.stop();
    console.log("[Gardener-Sweeper] Scheduler stopped");
  }
  if (cycleTask) {
    cycleTask.stop();
    console.log("[Gardener-Cycle] Scheduler stopped");
  }
  await closeDriver();
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
