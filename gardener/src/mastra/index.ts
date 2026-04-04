import { Mastra } from "@mastra/core/mastra";
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

async function gracefulShutdown(signal: string) {
  console.log(`[Gardener v3] Received ${signal}, closing connections...`);
  await closeDriver();
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
