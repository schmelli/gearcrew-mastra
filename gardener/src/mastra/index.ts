import { Mastra } from "@mastra/core/mastra";
import cron, { type ScheduledTask } from "node-cron";
import { gardenerV3 } from "../agents/gardener-v3.js";
import { brandCategoryScan } from "../workflows/brand-category-scan.js";
import { closeDriver } from "../lib/memgraph.js";

const port = parseInt(process.env.PORT || "4111", 10);

export const mastra = new Mastra({
  agents: { GardenerV3: gardenerV3 },
  workflows: { brandCategoryScan },
  server: {
    port,
    timeout: process.env.NODE_ENV === "production" ? 300000 : 600000,
  },
});

// ---------------------------------------------------------------------------
// Autonomous Scheduler — runs brand-category scans every 10 minutes
// If a scan returns "skipped", immediately retries with the next brand (up to MAX_RETRIES)
// ---------------------------------------------------------------------------

const MAX_SKIP_RETRIES = 10; // try up to 10 brands per tick before giving up

let scanTask: ScheduledTask | null = null;
let isRunning = false;

async function runScanCycle(): Promise<void> {
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
      continue; // immediately try next brand
    }

    // completed or error — log and stop
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
// Graceful shutdown
// ---------------------------------------------------------------------------

async function gracefulShutdown(signal: string) {
  console.log(`[Gardener v3] Received ${signal}, shutting down...`);
  if (scanTask) {
    scanTask.stop();
    console.log("[Gardener v3] Scheduler stopped");
  }
  await closeDriver();
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
