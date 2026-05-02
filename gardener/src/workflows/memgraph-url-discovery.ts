/**
 * Memgraph URL Discovery Workflow ("Klebefalle"-Aufwertung Phase 1)
 *
 * For every :GearItem in Memgraph that has neither product_url nor image_url
 * (the "naked" items that landed in the graph from a YouTube/article mention
 * but were never enriched), runs a Serper Google-search to discover the most
 * likely manufacturer/retailer product URL and stamps it onto the node.
 *
 * Combined with `memgraphImageScrape`, this turns the graph into a self-
 * healing system: any item that gets mentioned anywhere → trapped in the
 * graph → automatically gets a URL → automatically gets an image.
 *
 * Cost: $0.0003 per Serper search. 4296 candidates ≈ $1.30 total at full
 * scale. Hard-cap defaults to 1500 items per run ($0.45) so any single run
 * stays comfortably under cost expectations.
 */

import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import pLimit from "p-limit";
import { getReadSession, getWriteSession, toNumber } from "../lib/memgraph.js";
import {
  discoverProductUrl,
  type DiscoveryOutcome,
} from "../lib/serper-discovery.js";

const triggerSchema = z.object({
  mode: z.enum(["dry-run", "apply"]),
  limit: z.number().int().positive().optional(),
  concurrency: z.number().int().min(1).max(10).optional(),
  inter_request_delay_ms: z.number().int().min(0).max(5000).optional(),
  max_cost_credits: z.number().int().positive().optional(),
});

const sampleSchema = z.object({
  brand: z.string(),
  name: z.string(),
  outcome: z.string(),
  url: z.string().nullable(),
});

const outcomeBreakdownSchema = z.object({
  manufacturer_match: z.number(),
  retailer_fallback: z.number(),
  no_results: z.number(),
  all_blacklisted: z.number(),
  api_error: z.number(),
});

const outputSchema = z.object({
  mode: z.enum(["dry-run", "apply"]),
  total_candidates: z.number(),
  searched: z.number(),
  discovered: z.number(),
  written: z.number(),
  cost_credits_used: z.number(),
  cost_usd_estimate: z.number(),
  aborted_due_to_cost: z.boolean(),
  outcome_breakdown: outcomeBreakdownSchema,
  duration_seconds: z.number(),
  sample_discovered: z.array(sampleSchema),
  sample_no_results: z.array(sampleSchema),
});

const DEFAULT_LIMIT = 1500;
const DEFAULT_CONCURRENCY = 5;
const DEFAULT_INTER_REQUEST_DELAY_MS = 200;
const DEFAULT_MAX_COST_CREDITS = 1500; // ≈ $0.45 hard cap
const SERPER_COST_PER_CREDIT_USD = 0.0003;

interface Candidate {
  node_id: number;
  brand: string;
  name: string;
}

const READ_CYPHER = `
MATCH (g:GearItem)
WHERE g.product_url IS NULL
  AND g.image_url IS NULL
  AND g.brand IS NOT NULL
  AND g.name IS NOT NULL
RETURN ID(g) AS node_id,
       g.brand AS brand,
       g.name AS name
LIMIT toInteger($limit)
`;

const WRITE_CYPHER = `
MATCH (g:GearItem) WHERE ID(g) = $nodeId
SET g.product_url = $url,
    g.url_source = $source,
    g.url_discovered_at = datetime()
`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const discoverStep = createStep({
  id: "serper-discover-product-urls",
  description:
    "Find :GearItem nodes with neither product_url nor image_url, Serper-search them, stamp top result onto node",
  inputSchema: triggerSchema,
  outputSchema,
  async execute({ inputData }) {
    const limit = inputData.limit ?? DEFAULT_LIMIT;
    const concurrency = inputData.concurrency ?? DEFAULT_CONCURRENCY;
    const interDelay =
      inputData.inter_request_delay_ms ?? DEFAULT_INTER_REQUEST_DELAY_MS;
    const maxCreditsBudget =
      inputData.max_cost_credits ?? DEFAULT_MAX_COST_CREDITS;
    const startedAt = Date.now();

    const readSess = getReadSession();
    let candidates: Candidate[] = [];
    try {
      const result = await readSess.run(READ_CYPHER, { limit });
      candidates = result.records.map((r) => ({
        node_id: toNumber(r.get("node_id")),
        brand: r.get("brand") as string,
        name: r.get("name") as string,
      }));
    } finally {
      await readSess.close();
    }

    console.log(
      `[memgraph-url-discovery] mode=${inputData.mode} candidates=${candidates.length} concurrency=${concurrency} delay=${interDelay}ms budget=${maxCreditsBudget}cr`,
    );

    const writeSess = inputData.mode === "apply" ? getWriteSession() : null;
    const limiter = pLimit(concurrency);

    let searched = 0;
    let discovered = 0;
    let written = 0;
    let creditsUsed = 0;
    let abortedDueToCost = false;
    const breakdown: Record<DiscoveryOutcome, number> = {
      manufacturer_match: 0,
      retailer_fallback: 0,
      no_results: 0,
      all_blacklisted: 0,
      api_error: 0,
    };
    const sampleDiscovered: Array<z.infer<typeof sampleSchema>> = [];
    const sampleNoResults: Array<z.infer<typeof sampleSchema>> = [];

    let processed = 0;
    const total = candidates.length;
    let stopped = false;

    try {
      await Promise.all(
        candidates.map((c) =>
          limiter(async () => {
            if (stopped) return;
            // Pre-flight cost-check is checked again after each call. Reading
            // creditsUsed before the await is intentional — the budget is a
            // soft ceiling that may overshoot by `concurrency` credits in the
            // worst case (acceptable trade-off for parallelism).
            if (creditsUsed >= maxCreditsBudget) {
              stopped = true;
              abortedDueToCost = true;
              return;
            }

            if (interDelay > 0) await sleep(interDelay);

            const result = await discoverProductUrl(c.brand, c.name);
            searched += 1;
            creditsUsed += result.cost_credits;
            breakdown[result.outcome] += 1;

            if (result.url) {
              discovered += 1;
              if (inputData.mode === "apply" && writeSess) {
                try {
                  await writeSess.run(WRITE_CYPHER, {
                    nodeId: c.node_id,
                    url: result.url,
                    source: `serper:${result.outcome}`,
                  });
                  written += 1;
                } catch (err) {
                  console.error(
                    `[memgraph-url-discovery] write failed nodeId=${c.node_id}: ${err instanceof Error ? err.message : String(err)}`,
                  );
                }
              }
              if (sampleDiscovered.length < 10) {
                sampleDiscovered.push({
                  brand: c.brand,
                  name: c.name,
                  outcome: result.outcome,
                  url: result.url,
                });
              }
            } else if (sampleNoResults.length < 10) {
              sampleNoResults.push({
                brand: c.brand,
                name: c.name,
                outcome: result.outcome,
                url: null,
              });
            }

            processed += 1;
            if (processed % 100 === 0 || processed === total) {
              const elapsed = (Date.now() - startedAt) / 1000;
              const rate = elapsed > 0 ? processed / elapsed : 0;
              console.log(
                `[memgraph-url-discovery] ${processed}/${total} ` +
                `discovered=${discovered} written=${written} ` +
                `credits=${creditsUsed}/${maxCreditsBudget} ` +
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
      `[memgraph-url-discovery] done mode=${inputData.mode} searched=${searched} discovered=${discovered} written=${written} credits=${creditsUsed} aborted=${abortedDueToCost} duration=${duration.toFixed(1)}s`,
    );

    return {
      mode: inputData.mode,
      total_candidates: total,
      searched,
      discovered,
      written,
      cost_credits_used: creditsUsed,
      cost_usd_estimate: creditsUsed * SERPER_COST_PER_CREDIT_USD,
      aborted_due_to_cost: abortedDueToCost,
      outcome_breakdown: breakdown,
      duration_seconds: Math.round(duration),
      sample_discovered: sampleDiscovered,
      sample_no_results: sampleNoResults,
    };
  },
});

export const memgraphUrlDiscovery = createWorkflow({
  id: "memgraphUrlDiscovery",
  inputSchema: triggerSchema,
  outputSchema,
})
  .then(discoverStep)
  .commit();
