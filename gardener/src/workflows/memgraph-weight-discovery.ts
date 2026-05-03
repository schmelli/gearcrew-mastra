/**
 * Memgraph Weight Discovery Workflow
 *
 * For every :GearItem with a product_url but no weight_grams, fetches the
 * product page and extracts weight via the JSON-LD → DL/TR → label-pattern
 * fallback chain in `fetchProductWeight`. Cloudflare-blocked sites silently
 * fail through to Firecrawl when available; otherwise the item is left for
 * later passes.
 *
 * Conservative by design: parser rejects any value outside 1g–50kg to keep
 * mis-extracted shipping weights out of the graph.
 *
 * Two modes:
 *   - "dry-run": fetch + parse, no Memgraph writes
 *   - "apply":   stamp weight_grams + weight_source + weight_discovered_at
 */

import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import pLimit from "p-limit";
import { getReadSession, getWriteSession, toNumber } from "../lib/memgraph.js";
import { fetchProductWeight } from "../lib/enrichment-extractors.js";

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
  weight_grams: z.number(),
  source: z.string(),
  raw_text: z.string().optional(),
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
  AND g.product_url <> ''
  AND (g.weight_grams IS NULL OR g.weight_grams = 0)
RETURN ID(g) AS node_id,
       g.brand AS brand,
       g.name AS name,
       g.product_url AS product_url
LIMIT toInteger($limit)
`;

const WRITE_CYPHER = `
MATCH (g:GearItem) WHERE ID(g) = $nodeId
SET g.weight_grams = $weightGrams,
    g.weight_source = $source,
    g.weight_discovered_at = datetime()
`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const discoverStep = createStep({
  id: "discover-and-stamp-weights",
  description:
    "Fetch :GearItem nodes with product_url & no weight_grams, extract weight from page, write back",
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
      `[memgraph-weight-discovery] mode=${inputData.mode} candidates=${candidates.length} concurrency=${concurrency} delay=${interDelay}ms`,
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
            if (interDelay > 0) await sleep(interDelay);

            const result = await fetchProductWeight(c.product_url);

            if (
              result.weight_grams !== null &&
              result.source !== null
            ) {
              scrapedSuccess += 1;
              if (inputData.mode === "apply" && writeSess) {
                try {
                  await writeSess.run(WRITE_CYPHER, {
                    nodeId: c.node_id,
                    weightGrams: result.weight_grams,
                    source: result.source,
                  });
                  written += 1;
                } catch (err) {
                  console.error(
                    `[memgraph-weight-discovery] write failed nodeId=${c.node_id}: ${err instanceof Error ? err.message : String(err)}`,
                  );
                }
              }
              if (sampleSuccess.length < 10) {
                sampleSuccess.push({
                  brand: c.brand,
                  name: c.name,
                  product_url: c.product_url,
                  weight_grams: result.weight_grams,
                  source: result.source,
                  raw_text: result.raw_text,
                });
              }
            } else {
              scrapedFailed += 1;
              if (sampleFailed.length < 10) {
                sampleFailed.push({
                  brand: c.brand,
                  name: c.name,
                  product_url: c.product_url,
                  error: result.error ?? "no_weight_found",
                });
              }
            }

            processed += 1;
            if (processed % 100 === 0 || processed === total) {
              const elapsed = (Date.now() - startedAt) / 1000;
              const rate = elapsed > 0 ? processed / elapsed : 0;
              console.log(
                `[memgraph-weight-discovery] ${processed}/${total} ` +
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
      `[memgraph-weight-discovery] done mode=${inputData.mode} success=${scrapedSuccess} failed=${scrapedFailed} written=${written} duration=${duration.toFixed(1)}s`,
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

export const memgraphWeightDiscovery = createWorkflow({
  id: "memgraphWeightDiscovery",
  inputSchema: triggerSchema,
  outputSchema,
})
  .then(discoverStep)
  .commit();
