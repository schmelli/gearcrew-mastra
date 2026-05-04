export { graphQuery } from "./graph-query.js";
export { graphWrite } from "./graph-write.js";
export { webScrape } from "./web-scrape.js";
export { webSearch } from "./web-search.js";
export { validateSchema } from "./validate-schema.js";
export { getOntology } from "./get-ontology.js";

// P0 — agent self-awareness (added 2026-05-04, 3-layer Gardener architecture)
export { getEnrichmentGaps } from "./get-enrichment-gaps.js";
export { getRecentEnrichments } from "./get-recent-enrichments.js";

// P1 — atomic write + research wrappers
export { enrichGearItem } from "./enrich-gear-item.js";
export { enrichGearItemWeight } from "./enrich-gear-item-weight.js";
export { enrichGearItemImage } from "./enrich-gear-item-image.js";
export { discoverProductUrl } from "./discover-product-url.js";
export { classifyProductType } from "./classify-product-type.js";
