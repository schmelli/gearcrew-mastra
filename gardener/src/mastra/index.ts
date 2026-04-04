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
// Autonomous Scheduler — runs one brand-category scan every 30 minutes
// ---------------------------------------------------------------------------

let scanTask: ScheduledTask | null = null;
let isRunning = false;

function startScheduler(): void {
  const schedule = process.env.GARDENER_SCAN_SCHEDULE || "*/30 * * * *";
  const enabled = process.env.GARDENER_AUTONOMOUS !== "false"; // enabled by default

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
    const startTime = Date.now();
    console.log(`[Gardener v3] Autonomous scan starting...`);

    try {
      const workflow = mastra.getWorkflow("brandCategoryScan");
      const run = await workflow.createRun();
      const result = await run.start({ inputData: {} });
      const duration = Math.round((Date.now() - startTime) / 1000);
      console.log(`[Gardener v3] Scan complete (${duration}s):`, JSON.stringify(result).slice(0, 300));
    } catch (err) {
      const duration = Math.round((Date.now() - startTime) / 1000);
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
