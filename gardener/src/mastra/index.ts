import { Mastra } from "@mastra/core/mastra";
import { gardenerV3 } from "../agents/gardener-v3.js";
import { closeDriver } from "../lib/memgraph.js";

const port = parseInt(process.env.PORT || "4111", 10);

export const mastra = new Mastra({
  agents: { GardenerV3: gardenerV3 },
  // Workflows will be added in Phase 2
  server: {
    port,
    timeout: process.env.NODE_ENV === "production" ? 300000 : 600000,
  },
});

process.on("SIGTERM", async () => {
  console.log("[Gardener v3] Received SIGTERM, closing connections...");
  await closeDriver();
  process.exit(0);
});
