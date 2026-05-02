import { Mastra } from "@mastra/core/mastra";
import cron, { type ScheduledTask } from "node-cron";
import { gardenerHaiku, gardenerSonnet } from "../agents/gardener-v3.js";
import { youtubeGearExtractor } from "../agents/youtube-gear-extractor.js";
import { brandCategoryScan } from "../workflows/brand-category-scan.js";
import { youtubePlaylistIngest } from "../workflows/youtube-playlist-ingest.js";
import { brandDedup } from "../workflows/brand-dedup.js";
import { typeDedup } from "../workflows/type-dedup.js";
import { autoTypingFlash } from "../workflows/auto-typing.js";
import { enrichmentLite } from "../workflows/enrichment-lite.js";
import { enrichmentPremium } from "../workflows/enrichment-premium.js";
import { successorDetection } from "../workflows/successor-detection.js";
import { specNormalization } from "../workflows/spec-normalization.js";
import { supabaseMemgraphBridge } from "../workflows/supabase-memgraph-bridge.js";
import { backfillBridgeTranscripts } from "../workflows/backfill-bridge-transcripts.js";
import { backfillAllTranscripts } from "../workflows/backfill-all-transcripts.js";
import { tipClassification } from "../workflows/tip-classification.js";
import { insightMigration } from "../workflows/insight-migration.js";
import { memgraphProductTypeBackfill } from "../workflows/memgraph-product-type-backfill.js";
import { memgraphInsightsExtraction } from "../workflows/memgraph-insights-extraction.js";
import { rerouteFallbackTips } from "../workflows/reroute-fallback-tips.js";
import { familyCanonical } from "../workflows/family-canonical-names.js";
import { catalogImageBridge } from "../workflows/catalog-image-bridge.js";
import { memgraphImageScrape } from "../workflows/memgraph-image-scrape.js";
import { memgraphUrlDiscovery } from "../workflows/memgraph-url-discovery.js";
import { closeDriver } from "../lib/memgraph.js";

const port = parseInt(process.env.PORT || "4111", 10);

export const mastra = new Mastra({
  agents: {
    GardenerHaiku: gardenerHaiku,
    GardenerSonnet: gardenerSonnet,
    YoutubeGearExtractor: youtubeGearExtractor,
  },
  // brandDedup: manual-trigger only (no scheduler) per CONTEXT D-10 100% human-review-gate.
  // typeDedup: manual-trigger only (no scheduler) per CONTEXT D-12 — type-merge happens Gearshack-side via migration.
  // autoTypingFlash: manual-trigger only (no scheduler) per CONTEXT D-14 — production apply-runs require human-gating ($10 cost cap).
  // enrichmentLite: manual-trigger only (no scheduler) per Phase 09 GEA-1086+1087 scope-reduced launch flow ($5 combined cost cap).
  //                 Round-robin priority + per-type cooldown enabled by default (quick-260428-jux).
  // enrichmentPremium: manual-trigger only (registered quick-260428-ke7). $10 cost cap.
  //                 Description (Gemini Flash, 200-400 words) + insights (Memgraph
  //                 VideoSource transcripts -> tagged Insight nodes via HAS_INSIGHT/DERIVED_FROM).
  //                 Scheduler + cron defer to next deployment task.
  // successorDetection: manual-trigger only (registered quick-260428-jux). Scheduler deferred to follow-up.
  // specNormalization: manual-trigger only (registered quick-260428-jux). Scheduler deferred to follow-up.
  // supabaseMemgraphBridge: manual-trigger only (registered quick-260429). Stamps g.supabase_id on
  //                 Memgraph GearItem nodes by case-insensitive (brand, name) match. Prerequisite
  //                 for enrichmentPremium insights extraction.
  // productDiscovery + brandEnrichment: NOT registered — both still use legacy `new Workflow()` v2 API.
  //                 v2->v3 retrofit is its own task; defer to post-launch (quick-260428-jux scope decision).
  workflows: {
    brandCategoryScan,
    youtubePlaylistIngest,
    brandDedup,
    typeDedup,
    autoTypingFlash,
    enrichmentLite,
    enrichmentPremium,
    successorDetection,
    specNormalization,
    supabaseMemgraphBridge,
    backfillBridgeTranscripts,
    backfillAllTranscripts,
    tipClassification,
    insightMigration,
    memgraphProductTypeBackfill,
    memgraphInsightsExtraction,
    rerouteFallbackTips,
    familyCanonical,
    catalogImageBridge,
    memgraphImageScrape,
    memgraphUrlDiscovery,
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

  const workflow = mastra.getWorkflow("brandCategoryScan");

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
// Klebefalle-Aufwertung Scheduler
// Two coordinated cron jobs that turn the graph into a self-healing system:
//   1. URL-Discovery (every 6h at :00) — find product_url for naked items via
//      Serper. Hard-cap default 1500 credits ($0.45/run, $1.80/day).
//   2. Image-Scrape (every 6h at :30) — scrape og:image for any item with
//      product_url & no image_url. Free (just HTTP fetch).
// Disable individually via KLEBEFALLE_URL_AUTONOMOUS / KLEBEFALLE_IMAGE_AUTONOMOUS.
// ---------------------------------------------------------------------------

let urlDiscoveryTask: ScheduledTask | null = null;
let urlDiscoveryRunning = false;
let imageScrapeTask: ScheduledTask | null = null;
let imageScrapeRunning = false;

async function runUrlDiscoveryCycle(): Promise<void> {
  const workflow = mastra.getWorkflow("memgraphUrlDiscovery");
  const start = Date.now();
  const run = await workflow.createRunAsync();
  const result = await run.start({
    inputData: { mode: "apply" as const },
  });
  const seconds = Math.round((Date.now() - start) / 1000);
  const stepResult =
    (result as { result?: Record<string, unknown> }).result ?? {};
  console.log(
    `[Klebefalle-URL-Cron] cycle done in ${seconds}s — searched=${stepResult.searched ?? "?"} discovered=${stepResult.discovered ?? "?"} written=${stepResult.written ?? "?"} credits=${stepResult.cost_credits_used ?? "?"} aborted=${stepResult.aborted_due_to_cost ?? "?"}`,
  );
}

async function runImageScrapeCycle(): Promise<void> {
  const workflow = mastra.getWorkflow("memgraphImageScrape");
  const start = Date.now();
  const run = await workflow.createRunAsync();
  const result = await run.start({
    inputData: { mode: "apply" as const },
  });
  const seconds = Math.round((Date.now() - start) / 1000);
  const stepResult =
    (result as { result?: Record<string, unknown> }).result ?? {};
  console.log(
    `[Klebefalle-Image-Cron] cycle done in ${seconds}s — candidates=${stepResult.total_candidates ?? "?"} success=${stepResult.scraped_success ?? "?"} written=${stepResult.written ?? "?"}`,
  );
}

function startKlebefalleSchedulers(): void {
  const urlSchedule = process.env.KLEBEFALLE_URL_SCHEDULE || "0 */6 * * *"; // every 6h on :00
  const urlEnabled = process.env.KLEBEFALLE_URL_AUTONOMOUS !== "false";
  const imageSchedule =
    process.env.KLEBEFALLE_IMAGE_SCHEDULE || "30 */6 * * *"; // every 6h on :30
  const imageEnabled = process.env.KLEBEFALLE_IMAGE_AUTONOMOUS !== "false";

  if (urlEnabled) {
    urlDiscoveryTask = cron.schedule(
      urlSchedule,
      async () => {
        if (urlDiscoveryRunning) {
          console.log("[Klebefalle-URL-Cron] Previous cycle still running, skipping");
          return;
        }
        urlDiscoveryRunning = true;
        try {
          await runUrlDiscoveryCycle();
        } catch (err) {
          console.error("[Klebefalle-URL-Cron] Cycle failed:", err);
        } finally {
          urlDiscoveryRunning = false;
        }
      },
      { timezone: "UTC" },
    );
    console.log(`[Klebefalle-URL-Cron] Scheduler started: "${urlSchedule}" (UTC)`);
  } else {
    console.log("[Klebefalle-URL-Cron] Disabled (KLEBEFALLE_URL_AUTONOMOUS=false)");
  }

  if (imageEnabled) {
    imageScrapeTask = cron.schedule(
      imageSchedule,
      async () => {
        if (imageScrapeRunning) {
          console.log("[Klebefalle-Image-Cron] Previous cycle still running, skipping");
          return;
        }
        imageScrapeRunning = true;
        try {
          await runImageScrapeCycle();
        } catch (err) {
          console.error("[Klebefalle-Image-Cron] Cycle failed:", err);
        } finally {
          imageScrapeRunning = false;
        }
      },
      { timezone: "UTC" },
    );
    console.log(
      `[Klebefalle-Image-Cron] Scheduler started: "${imageSchedule}" (UTC)`,
    );
  } else {
    console.log("[Klebefalle-Image-Cron] Disabled (KLEBEFALLE_IMAGE_AUTONOMOUS=false)");
  }
}

setTimeout(() => startKlebefalleSchedulers(), 9000);

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
  if (urlDiscoveryTask) {
    urlDiscoveryTask.stop();
    console.log("[Klebefalle-URL-Cron] Scheduler stopped");
  }
  if (imageScrapeTask) {
    imageScrapeTask.stop();
    console.log("[Klebefalle-Image-Cron] Scheduler stopped");
  }
  await closeDriver();
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
