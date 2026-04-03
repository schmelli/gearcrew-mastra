import { Mastra } from "@mastra/core/mastra";
import { gardener } from "../agents/gardener.js";
import { variantDetection } from "../workflows/variant-detection.js";
import { closeDriver } from "../lib/memgraph.js";

const port = parseInt(process.env.PORT || "4111", 10);

export const mastra = new Mastra({
  agents: { gardener },
  workflows: { variantDetection },
  server: {
    port,
    timeout: process.env.NODE_ENV === "production" ? 120000 : 600000,
  },
});

process.on("SIGTERM", async () => {
  console.log("[Gardener] SIGTERM received, closing connections...");
  await closeDriver();
  process.exit(0);
});
