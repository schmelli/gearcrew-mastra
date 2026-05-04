/**
 * enrichGearItemImage — og:image / Twitter / JSON-LD product-image extractor
 *
 * Wraps `lib/enrichment-extractors.ts::fetchOgImage` which runs:
 *   1. og:image meta tag
 *   2. itemprop="image" meta tag
 *   3. twitter:image meta tag
 *   4. JSON-LD Product schema "image" field
 *   5. Firecrawl fallback (rendered HTML for JS / Cloudflare sites)
 *
 * Returns the resolved absolute URL + source so the agent can pass it to
 * `enrichGearItem`. Does NOT write — keeps Schreib-Disziplin centralized.
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { fetchOgImage } from "../lib/enrichment-extractors.js";

export const enrichGearItemImage = createTool({
  id: "enrichGearItemImage",
  description: `Extract a product image URL from a manufacturer/retailer URL.
Runs the og:image → itemprop=image → twitter:image → JSON-LD product image
chain, with Firecrawl fallback for JS-rendered / Cloudflare-blocked pages.
Returns image_url + source; does NOT write to Memgraph. Use enrichGearItem
to persist with the agent's confidence.`,
  inputSchema: z.object({
    productUrl: z.string().url().describe("Manufacturer or retailer product page URL"),
    reason: z.string().describe("Why image is being fetched (audit-log)"),
  }),
  outputSchema: z.object({
    image_url: z.string().nullable(),
    source: z.string().nullable(),
    error: z.string().optional(),
    suggested_confidence: z.number().min(0).max(1),
  }),
  execute: async ({ context: { productUrl } }) => {
    const result = await fetchOgImage(productUrl);
    // og:image / json-ld:product → high confidence (0.95)
    // twitter:image / itemprop:image / firecrawl-* → medium-high (0.85)
    let suggested = 0;
    if (result.source === "og:image" || result.source === "json-ld:product") {
      suggested = 0.95;
    } else if (
      result.source === "itemprop:image" ||
      result.source === "twitter:image" ||
      result.source?.startsWith("firecrawl:")
    ) {
      suggested = 0.85;
    }
    return {
      image_url: result.image_url,
      source: result.source,
      error: result.error,
      suggested_confidence: suggested,
    };
  },
});
