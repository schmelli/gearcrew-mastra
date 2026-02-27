import { Mastra } from "@mastra/core/mastra";
import { gardener } from "./agents/gardener.js";
// TODO: Fix workflow TypeScript errors for @mastra/core@0.24.x API
// import { brandEnrichment } from "./workflows/brand-enrichment.js";
// import { productDiscovery } from "./workflows/product-discovery.js";
// import { dataQualityAudit } from "./workflows/data-quality-audit.js";
// import { relationshipWeave } from "./workflows/relationship-weave.js";
import { closeDriver } from "./lib/memgraph.js";

const port = parseInt(process.env.PORT || "4111", 10);

export const mastra = new Mastra({
  agents: { gardener },
  server: {
    port,
    timeout: process.env.NODE_ENV === "production" ? 120000 : 600000, // 2 min in prod, 10 min in dev
  },
});

process.on("SIGTERM", async () => {
  console.log("[Gardener] SIGTERM received, closing connections...");
  await closeDriver();
  process.exit(0);
});
