/**
 * discoverProductUrl — Serper-search wrapper with manufacturer-domain ranking
 *
 * Wraps `lib/serper-discovery.ts::discoverProductUrl` which performs a Serper
 * Google search for "<brand> <name>" and ranks the candidates:
 *   - Brand-as-SLD-or-segment in hostname → score 3
 *   - Brand anywhere in hostname           → score 2
 *   - Otherwise (generic retailer)         → score 0 / fallback
 *
 * Blacklist (51 domains): Amazon, eBay, Reddit, YouTube, Walmart, Pinterest,
 * Facebook, Instagram, TikTok, Twitter, Wikipedia, Google, Bing, Trustpilot,
 * Tripadvisor, Quora + regional variants. These are filtered out before
 * ranking.
 *
 * Returns the best URL + outcome; does NOT write to Memgraph. Use
 * `enrichGearItem` with target='product_url' to persist.
 *
 * Cost: ~$0.0003 per call (1 Serper credit).
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { discoverProductUrl as discoverProductUrlLib } from "../lib/serper-discovery.js";

export const discoverProductUrl = createTool({
  id: "discoverProductUrl",
  description: `Find the most likely manufacturer/retailer product URL for a (brand, name) pair via ranked Serper Google-search.
Returns:
  - url: the chosen URL or null
  - outcome: 'manufacturer_match' (brand-domain) | 'retailer_fallback' | 'no_results' | 'all_blacklisted' | 'api_error'
  - candidate_count: how many results were returned by Serper
  - cost_credits: 1 per call (~$0.0003)

The blacklist filters out marketplaces (Amazon/eBay/Walmart), social
platforms (Reddit/YouTube/Facebook), and generic indexes (Wikipedia/Google).
Use this BEFORE webSearch when the agent specifically wants a product URL —
it spares 800 tokens of reasoning over Serper raw results.

Does NOT write to Memgraph. Use enrichGearItem with target='product_url' to persist.`,
  inputSchema: z.object({
    brand: z.string().min(1).describe("Outdoor brand name (e.g. 'MSR', 'Hilleberg')"),
    name: z.string().min(1).describe("Product name (e.g. 'Hubba Hubba NX 2')"),
    reason: z.string().describe("Why URL is being discovered (audit-log)"),
  }),
  outputSchema: z.object({
    url: z.string().nullable(),
    outcome: z.enum([
      "manufacturer_match",
      "retailer_fallback",
      "no_results",
      "all_blacklisted",
      "api_error",
    ]),
    candidate_count: z.number(),
    cost_credits: z.number(),
    error: z.string().optional(),
    suggested_confidence: z.number().min(0).max(1),
  }),
  execute: async ({ context: { brand, name } }) => {
    const result = await discoverProductUrlLib(brand, name);
    // manufacturer_match → 0.95 (brand-domain is the canonical source)
    // retailer_fallback  → 0.75 (good-enough but not authoritative)
    // others             → 0
    let suggested = 0;
    if (result.outcome === "manufacturer_match") suggested = 0.95;
    else if (result.outcome === "retailer_fallback") suggested = 0.75;
    return {
      url: result.url,
      outcome: result.outcome,
      candidate_count: result.candidate_count,
      cost_credits: result.cost_credits,
      error: result.error,
      suggested_confidence: suggested,
    };
  },
});
