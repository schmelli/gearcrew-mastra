/**
 * Memgraph Image-Scrape Workflow
 *
 * Quick-Task 260502-catalog-image-bridge / Phase 2.
 *
 * Reads :GearItem nodes that have product_url but no image_url, fetches the
 * og:image / itemprop=image meta-tag from the product page, and writes the
 * resolved URL back onto the Memgraph node.
 *
 * Re-uses `fetchOgImage()` from lib/enrichment-extractors.ts (already battle-
 * tested in enrichmentLite). Concurrency is bounded via p-limit so we don't
 * hammer any single retailer; 500ms delay between requests for politeness.
 *
 * Idempotent: filter `g.image_url IS NULL`. Reruns continue where the prior
 * run stopped (or where new product_urls have been stamped since).
 *
 * Two modes:
 *   - "dry-run": fetches og:image but does NOT write to Memgraph (smoke test
 *                URL pool + scrape success rate)
 *   - "apply":   writes resolved URLs back via SET g.image_url = $url
 */

import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import pLimit from "p-limit";
import { getReadSession, getWriteSession, toNumber } from "../lib/memgraph.js";
import { fetchOgImage } from "../lib/enrichment-extractors.js";

const triggerSchema = z.object({
  mode: z.enum(["dry-run", "apply"]),
  limit: z.number().int().positive().optional(),
  concurrency: z.number().int().min(1).max(20).optional(),
  inter_request_delay_ms: z.number().int().min(0).max(5000).optional(),
});

const failureSampleSchema = z.object({
  brand: z.string(),
  name: z.string(),
  product_url: z.string(),
  error: z.string(),
});

const successSampleSchema = z.object({
  brand: z.string(),
  name: z.string(),
  product_url: z.string(),
  image_url: z.string(),
  source: z.string(),
});

const outputSchema = z.object({
  mode: z.enum(["dry-run", "apply"]),
  total_candidates: z.number(),
  scraped_success: z.number(),
  scraped_failed: z.number(),
  written: z.number(),
  duration_seconds: z.number(),
  sample_success: z.array(successSampleSchema),
  sample_failed: z.array(failureSampleSchema),
});

const DEFAULT_LIMIT = 5000;
const DEFAULT_CONCURRENCY = 5;
const DEFAULT_INTER_REQUEST_DELAY_MS = 500;

interface Candidate {
  node_id: number;
  brand: string;
  name: string;
  product_url: string;
}

const READ_CYPHER = `
MATCH (g:GearItem)
WHERE g.product_url IS NOT NULL
  AND g.image_url IS NULL
RETURN ID(g) AS node_id,
       g.brand AS brand,
       g.name AS name,
       g.product_url AS product_url
ORDER BY g.bridge_stamped_at DESC
LIMIT $limit
`;

const WRITE_CYPHER = `
MATCH (g:GearItem) WHERE ID(g) = $nodeId
SET g.image_url = $imageUrl,
    g.image_source = $source,
    g.image_scraped_at = datetime()
`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const scrapeStep = createStep({
  id: "scrape-and-stamp-images",
  description:
    "Fetch :GearItem nodes with product_url & no image_url, scrape og:image, write back",
  inputSchema: triggerSchema,
  outputSchema,
  async execute({ inputData }) {
    const limit = inputData.limit ?? DEFAULT_LIMIT;
    const concurrency = inputData.concurrency ?? DEFAULT_CONCURRENCY;
    const interDelay =
      inputData.inter_request_delay_ms ?? DEFAULT_INTER_REQUEST_DELAY_MS;
    const startedAt = Date.now();

    const readSess = getReadSession();
    let candidates: Candidate[] = [];
    try {
      const result = await readSess.run(READ_CYPHER, { limit });
      candidates = result.records.map((r) => ({
        node_id: toNumber(r.get("node_id")),
        brand: r.get("brand") as string,
        name: r.get("name") as string,
        product_url: r.get("product_url") as string,
      }));
    } finally {
      await readSess.close();
    }

    console.log(
      `[memgraph-image-scrape] mode=${inputData.mode} candidates=${candidates.length} concurrency=${concurrency} delay=${interDelay}ms`,
    );

    const writeSess = inputData.mode === "apply" ? getWriteSession() : null;
    const limiter = pLimit(concurrency);

    let scrapedSuccess = 0;
    let scrapedFailed = 0;
    let written = 0;
    const sampleSuccess: Array<z.infer<typeof successSampleSchema>> = [];
    const sampleFailed: Array<z.infer<typeof failureSampleSchema>> = [];

    let processed = 0;
    const total = candidates.length;

    try {
      await Promise.all(
        candidates.map((c) =>
          limiter(async () => {
            // Per-request politeness delay (each request waits this long
            // before issuing — reduces burst pressure on any single host).
            if (interDelay > 0) await sleep(interDelay);

            const result = await fetchOgImage(c.product_url);

            if (result.image_url && result.source) {
              scrapedSuccess += 1;
              if (inputData.mode === "apply" && writeSess) {
                try {
                  await writeSess.run(WRITE_CYPHER, {
                    nodeId: c.node_id,
                    imageUrl: result.image_url,
                    source: result.source,
                  });
                  written += 1;
                } catch (err) {
                  console.error(
                    `[memgraph-image-scrape] write failed nodeId=${c.node_id}: ${err instanceof Error ? err.message : String(err)}`,
                  );
                }
              }
              if (sampleSuccess.length < 10) {
                sampleSuccess.push({
                  brand: c.brand,
                  name: c.name,
                  product_url: c.product_url,
                  image_url: result.image_url,
                  source: result.source,
                });
              }
            } else {
              scrapedFailed += 1;
              if (sampleFailed.length < 10) {
                sampleFailed.push({
                  brand: c.brand,
                  name: c.name,
                  product_url: c.product_url,
                  error: result.error ?? "no_og_image",
                });
              }
            }

            processed += 1;
            if (processed % 100 === 0 || processed === total) {
              const elapsed = (Date.now() - startedAt) / 1000;
              const rate = elapsed > 0 ? processed / elapsed : 0;
              console.log(
                `[memgraph-image-scrape] ${processed}/${total} ` +
                `success=${scrapedSuccess} failed=${scrapedFailed} written=${written} ` +
                `rate=${rate.toFixed(1)}/s`,
              );
            }
          }),
        ),
      );
    } finally {
      if (writeSess) await writeSess.close();
    }

    const duration = (Date.now() - startedAt) / 1000;
    console.log(
      `[memgraph-image-scrape] done mode=${inputData.mode} success=${scrapedSuccess} failed=${scrapedFailed} written=${written} duration=${duration.toFixed(1)}s`,
    );

    return {
      mode: inputData.mode,
      total_candidates: total,
      scraped_success: scrapedSuccess,
      scraped_failed: scrapedFailed,
      written,
      duration_seconds: Math.round(duration),
      sample_success: sampleSuccess,
      sample_failed: sampleFailed,
    };
  },
});

export const memgraphImageScrape = createWorkflow({
  id: "memgraphImageScrape",
  inputSchema: triggerSchema,
  outputSchema,
})
  .then(scrapeStep)
  .commit();
