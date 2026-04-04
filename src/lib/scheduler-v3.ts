/**
 * Gardener v3 Scheduler Integration
 * Sets up the brand-category-scan workflow on a 30-minute interval.
 * Each tick scans ONE brand+category combination (least-recently-audited first).
 */

import { getScheduler } from "./scheduler.js";
import { mastra } from "../../gardener/src/mastra/index.js";

export function setupGardenerV3Schedule(): void {
  const scheduler = getScheduler();

  // Brand-Category Scan: every 30 minutes
  scheduler.schedule(
    "gardener-v3-scan",
    "*/30 * * * *",
    async () => {
      console.log("[Gardener v3] Starting brand-category scan cycle...");
      const workflow = mastra.getWorkflow("brandCategoryScan");
      const run = await workflow.createRun();
      const result = await run.start({ inputData: {} });
      console.log(
        "[Gardener v3] Cycle complete:",
        JSON.stringify(result).slice(0, 200),
      );
    },
    { description: "Gardener v3: Brand-Category scan (one category per tick)" },
  );

  console.log(
    "[Gardener v3] Scheduler initialized: brand-category scan every 30 minutes",
  );
}
