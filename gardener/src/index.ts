import { Mastra } from "@mastra/core/mastra";
import { gardener } from "./agents/gardener";
import { brandEnrichment } from "./workflows/brand-enrichment";
import { productDiscovery } from "./workflows/product-discovery";
import { dataQualityAudit } from "./workflows/data-quality-audit";
import { relationshipWeave } from "./workflows/relationship-weave";

export const mastra = new Mastra({
  agents: { gardener },
  workflows: {
    brandEnrichment,
    productDiscovery,
    dataQualityAudit,
    relationshipWeave,
  },
  server: {
    port: 4111,
    timeout: 600000, // 10 min for local dev
  },
});
