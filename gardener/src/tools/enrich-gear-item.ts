/**
 * enrichGearItem — atomic property write with confidence-routing
 *
 * The Gardener-Haiku agent's PRIMARY tool for filling enrichment gaps.
 * Replaces ad-hoc graphWrite calls for spec-property updates so every write
 * carries provenance + confidence + evidence_url and the cooldown-tracker
 * is updated in lockstep.
 *
 * Confidence routing:
 *   confidence >= 0.85   → MERGE the property + provenance triade onto :GearItem,
 *                          mark cooldown success, set g.last_enriched_at
 *   confidence in [0.5, 0.85)
 *                        → DO NOT write to Memgraph; INSERT a row into Supabase
 *                          gardener_review_queue for human review
 *   confidence < 0.5     → silently dropped; touch cooldown so we don't loop
 *
 * Memgraph property scheme per target (forced):
 *   g.<target> = $value
 *   g.<target>_source = $source
 *   g.<target>_confidence = $confidence
 *   g.<target>_discovered_at = datetime()
 *   g.<target>_evidence_url = $evidence_url
 *   g.last_enriched_at = datetime()  (master cooldown)
 *
 * Note: gardener_review_queue migration lands in Phase 3.1; until then the
 * low-conf branch logs a warning + touches cooldown without inserting. Phase
 * 3 wires the actual queue insert.
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getWriteSession } from "../lib/memgraph.js";
import {
  markSuccess,
  touchAttempt,
  COOLDOWN_TARGETS,
  type CooldownTarget,
} from "../lib/cooldown-tracker.js";
import { getSupabase } from "../lib/supabase.js";

// Allowlist of writeable targets. Restricts the property-name surface so the
// agent cannot inject arbitrary property updates.
const ENRICH_TARGETS = COOLDOWN_TARGETS;
type EnrichTarget = CooldownTarget;

const HIGH_CONF_THRESHOLD = 0.85;
const LOW_CONF_THRESHOLD = 0.5;

// Memgraph property names per target — must match cooldown-tracker.ts.
// Hardcoded to prevent injection.
const PROP_FOR_TARGET: Record<EnrichTarget, string> = {
  weight_grams: "weight_grams",
  image_url: "image_url",
  product_url: "product_url",
  product_type: "__relationship__", // handled via :IS_TYPE edge, not property
  product_family: "__relationship__", // handled via :IS_VARIANT_OF edge
  description: "description",
  insights: "__relationship__", // handled via :HAS_INSIGHT edges
  successor_check: "successor_check_at", // marker timestamp only
};

const SOURCE_PROP: Record<EnrichTarget, string> = {
  weight_grams: "weight_source",
  image_url: "image_source",
  product_url: "url_source",
  product_type: "product_type_source",
  product_family: "product_family_source",
  description: "description_source",
  insights: "insights_source",
  successor_check: "successor_check_source",
};

const CONF_PROP: Record<EnrichTarget, string> = {
  weight_grams: "weight_confidence",
  image_url: "image_confidence",
  product_url: "url_confidence",
  product_type: "product_type_confidence",
  product_family: "product_family_confidence",
  description: "description_confidence",
  insights: "insights_confidence",
  successor_check: "successor_check_confidence",
};

const EVIDENCE_PROP: Record<EnrichTarget, string> = {
  weight_grams: "weight_evidence_url",
  image_url: "image_evidence_url",
  product_url: "url_evidence_url",
  product_type: "product_type_evidence_url",
  product_family: "product_family_evidence_url",
  description: "description_evidence_url",
  insights: "insights_evidence_url",
  successor_check: "successor_check_evidence_url",
};

export const enrichGearItem = createTool({
  id: "enrichGearItem",
  description: `Atomically write an enrichment property onto a :GearItem with provenance + confidence.
This is the PREFERRED tool for filling gaps — it enforces:
  - source + confidence + evidence_url + discovered_at on every write
  - cooldown bookkeeping (last_enriched_at, attempt counters)
  - confidence-routing: high (>=0.85) writes to Memgraph; medium (0.5-0.85)
    routes to gardener_review_queue for human review; low (<0.5) drops with
    a cooldown touch so the agent doesn't loop on it.

Targets: weight_grams, image_url, product_url, description, successor_check
For relationship-targets (product_type, product_family, insights), use the
dedicated tools (classifyProductType, linkOrCreateFamily, extractInsightsFromTranscripts).

Always provide an evidence_url that backs your value.`,
  inputSchema: z.object({
    nodeId: z
      .union([z.string(), z.number()])
      .describe("Memgraph internal node ID of the :GearItem"),
    target: z.enum(ENRICH_TARGETS).describe("Which property to enrich"),
    value: z
      .union([z.string(), z.number(), z.null()])
      .describe(
        "The value to write (number for weight_grams, string for URLs/text, null deliberately not supported here — use markFailure semantics by omitting the call)",
      ),
    source: z
      .string()
      .describe(
        "Where the value came from: 'manufacturer_scrape' | 'cross_ref' | 'agent_synthesis' | 'json_ld' | 'firecrawl' | 'serper' | 'llm_body_prose' | etc.",
      ),
    confidence: z
      .number()
      .min(0)
      .max(1)
      .describe(
        "Agent's confidence in [0, 1]. >=0.85 writes directly. 0.5-0.85 queues for review. <0.5 drops.",
      ),
    evidence_url: z
      .string()
      .url()
      .optional()
      .describe("Source URL backing the value (strongly recommended; required for source != 'agent_synthesis')"),
    reason: z
      .string()
      .describe("Why this enrichment is being performed (audit-log)"),
  }),
  outputSchema: z.object({
    written: z.boolean(),
    routed_to_review: z.boolean(),
    dropped_low_conf: z.boolean(),
    summary: z.string(),
  }),
  execute: async ({
    context: { nodeId, target, value, source, confidence, evidence_url, reason },
  }) => {
    if (PROP_FOR_TARGET[target] === "__relationship__") {
      throw new Error(
        `[enrichGearItem] target='${target}' is a relationship-write — use the dedicated tool (classifyProductType / linkOrCreateFamily / extractInsightsFromTranscripts).`,
      );
    }

    if (value === null || value === undefined) {
      throw new Error(
        `[enrichGearItem] value is null/undefined — to record a failed attempt, omit this call and use the cooldown via touchAttempt internally`,
      );
    }

    // --- Low-confidence drop ---
    if (confidence < LOW_CONF_THRESHOLD) {
      await touchAttempt(
        nodeId,
        target,
        `low_confidence_drop conf=${confidence.toFixed(2)} reason=${reason.slice(0, 100)}`,
      );
      return {
        written: false,
        routed_to_review: false,
        dropped_low_conf: true,
        summary: `dropped (confidence ${confidence.toFixed(2)} < ${LOW_CONF_THRESHOLD}); cooldown touched`,
      };
    }

    // --- Medium confidence: route to gardener_review_queue ---
    if (confidence < HIGH_CONF_THRESHOLD) {
      const ok = await routeToReviewQueue({
        nodeId: String(nodeId),
        target,
        value,
        source,
        confidence,
        evidence_url,
        reason,
      });
      // Touch cooldown so we don't propose the same value repeatedly while
      // it sits in review.
      await touchAttempt(
        nodeId,
        target,
        `medium_conf_to_review conf=${confidence.toFixed(2)}`,
      );
      return {
        written: false,
        routed_to_review: ok,
        dropped_low_conf: false,
        summary: ok
          ? `routed to gardener_review_queue (confidence ${confidence.toFixed(2)})`
          : `medium-conf write failed to queue (Phase 3 not yet deployed); cooldown touched`,
      };
    }

    // --- High confidence: write to Memgraph ---
    const propName = PROP_FOR_TARGET[target];
    const sourceProp = SOURCE_PROP[target];
    const confProp = CONF_PROP[target];
    const evidenceProp = EVIDENCE_PROP[target];

    // Build SET clauses literally — property names are whitelisted, never user input.
    const cypher = `
MATCH (g:GearItem) WHERE ID(g) = toInteger($nodeId)
SET g.${propName} = $value,
    g.${sourceProp} = $source,
    g.${confProp} = $confidence,
    g.${evidenceProp} = $evidence_url,
    g.last_enriched_at = datetime()
RETURN ID(g) AS id
`.trim();

    const session = getWriteSession();
    try {
      const result = await session.run(cypher, {
        nodeId: typeof nodeId === "string" ? Number(nodeId) : nodeId,
        value,
        source,
        confidence,
        evidence_url: evidence_url ?? null,
      });
      if (result.records.length === 0) {
        throw new Error(`[enrichGearItem] no node found for ID ${nodeId}`);
      }
    } finally {
      await session.close();
    }

    // Update cooldown bookkeeping (resets attempt counter, stamps discovered_at).
    await markSuccess(nodeId, target, source);

    console.log(
      `[enrichGearItem] ${target}=${truncate(value)} conf=${confidence.toFixed(2)} src=${source} reason=${reason.slice(0, 60)}`,
    );

    return {
      written: true,
      routed_to_review: false,
      dropped_low_conf: false,
      summary: `wrote ${target} (confidence ${confidence.toFixed(2)}, source ${source})`,
    };
  },
});

// ---------------------------------------------------------------------------
// Review-queue routing (Phase-3-aware: graceful degrade if table missing)
// ---------------------------------------------------------------------------

interface ReviewQueueArgs {
  nodeId: string;
  target: EnrichTarget;
  value: string | number;
  source: string;
  confidence: number;
  evidence_url: string | undefined;
  reason: string;
}

async function routeToReviewQueue(args: ReviewQueueArgs): Promise<boolean> {
  try {
    const supa = getSupabase();
    const row = {
      proposal_type: targetToProposalType(args.target),
      memgraph_node_id: args.nodeId,
      target_property: args.target,
      suggested_value: { value: args.value },
      confidence: args.confidence,
      source: args.source,
      evidence_urls: args.evidence_url ? [args.evidence_url] : [],
      reasoning: args.reason.slice(0, 1000),
      status: "pending" as const,
    };
    const { error } = await supa
      .from("gardener_review_queue")
      .upsert(row, {
        onConflict: "memgraph_node_id,proposal_type,target_property",
      });
    if (error) {
      // Phase-3 graceful degrade: table doesn't exist yet
      if (error.code === "42P01" || error.message?.toLowerCase().includes("does not exist")) {
        console.warn(
          `[enrichGearItem] gardener_review_queue not yet deployed; medium-conf proposal logged only: ${args.target}=${truncate(args.value)} conf=${args.confidence.toFixed(2)}`,
        );
        return false;
      }
      throw new Error(error.message);
    }
    return true;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[enrichGearItem] review-queue insert failed: ${reason}`);
    return false;
  }
}

function targetToProposalType(target: EnrichTarget): string {
  if (target === "weight_grams") return "spec_value";
  if (target === "image_url") return "spec_value";
  if (target === "product_url") return "spec_value";
  if (target === "description") return "description";
  if (target === "successor_check") return "successor_link";
  // relationship targets shouldn't reach here, but provide a default
  return target;
}

function truncate(value: unknown): string {
  const s = String(value);
  return s.length > 60 ? s.slice(0, 57) + "..." : s;
}
