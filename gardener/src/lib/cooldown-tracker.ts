/**
 * Cooldown-Tracker — per-target attempt counters and timestamps on :GearItem
 *
 * The Gardener's enrichment-cycle calls these helpers at three moments:
 *
 *   1. BEFORE working on a target (read-side check):
 *      `getRecentEnrichments(nodeId)` → if the target is in cooldown, skip.
 *      Cooldowns: 7d after success on a top-50 item, 30d on a long-tail item.
 *
 *   2. AFTER a failed attempt:
 *      `touchAttempt(nodeId, target, error?)` increments the attempt counter
 *      and stamps `g.last_<target>_attempted_at`. After 3 failures the item
 *      gets `g.<target>_abandoned_at` and won't be picked again until a
 *      30-day backoff has elapsed.
 *
 *   3. AFTER a successful enrichment:
 *      `markSuccess(nodeId, target, source?)` resets the attempt counter,
 *      stamps `g.<target>_discovered_at` AND `g.last_enriched_at` (master
 *      cooldown), and clears any abandoned marker.
 *
 * The Memgraph property scheme is one set per target. Whitelist enforced
 * server-side to prevent property-name injection through the workflow inputs.
 */

import { getWriteSession, getReadSession, toNumber } from "./memgraph.js";

// ---------------------------------------------------------------------------
// Targets & property mapping
// ---------------------------------------------------------------------------

export const COOLDOWN_TARGETS = [
  "weight_grams",
  "image_url",
  "product_url",
  "product_type",
  "product_family",
  "description",
  "insights",
  "successor_check",
] as const;

export type CooldownTarget = (typeof COOLDOWN_TARGETS)[number];

const TARGET_SET = new Set<string>(COOLDOWN_TARGETS);

function assertTarget(target: string): asserts target is CooldownTarget {
  if (!TARGET_SET.has(target)) {
    throw new Error(
      `[cooldown-tracker] Unknown target: "${target}". Valid: ${[...TARGET_SET].join(", ")}`,
    );
  }
}

/**
 * Per-target property names. Hardcoded — never construct property names from
 * untrusted input. Memgraph parameters do not interpolate into property keys,
 * so the Cypher must reference them literally.
 */
const PROP_NAMES: Record<
  CooldownTarget,
  {
    attemptedAt: string;
    attemptCount: string;
    lastError: string;
    discoveredAt: string;
    abandonedAt: string;
    source: string;
  }
> = {
  weight_grams: {
    attemptedAt: "last_weight_attempted_at",
    attemptCount: "weight_attempt_count",
    lastError: "weight_last_error",
    discoveredAt: "weight_discovered_at",
    abandonedAt: "weight_abandoned_at",
    source: "weight_source",
  },
  image_url: {
    attemptedAt: "last_image_attempted_at",
    attemptCount: "image_attempt_count",
    lastError: "image_last_error",
    discoveredAt: "image_scraped_at",
    abandonedAt: "image_abandoned_at",
    source: "image_source",
  },
  product_url: {
    attemptedAt: "last_url_attempted_at",
    attemptCount: "url_attempt_count",
    lastError: "url_last_error",
    discoveredAt: "url_discovered_at",
    abandonedAt: "url_abandoned_at",
    source: "url_source",
  },
  product_type: {
    attemptedAt: "last_product_type_attempted_at",
    attemptCount: "product_type_attempt_count",
    lastError: "product_type_last_error",
    discoveredAt: "product_type_classified_at",
    abandonedAt: "product_type_abandoned_at",
    source: "product_type_source",
  },
  product_family: {
    attemptedAt: "last_product_family_attempted_at",
    attemptCount: "product_family_attempt_count",
    lastError: "product_family_last_error",
    discoveredAt: "product_family_linked_at",
    abandonedAt: "product_family_abandoned_at",
    source: "product_family_source",
  },
  description: {
    attemptedAt: "last_description_attempted_at",
    attemptCount: "description_attempt_count",
    lastError: "description_last_error",
    discoveredAt: "description_generated_at",
    abandonedAt: "description_abandoned_at",
    source: "description_source",
  },
  insights: {
    attemptedAt: "last_insights_attempted_at",
    attemptCount: "insights_attempt_count",
    lastError: "insights_last_error",
    discoveredAt: "insights_extracted_at",
    abandonedAt: "insights_abandoned_at",
    source: "insights_source",
  },
  successor_check: {
    attemptedAt: "last_successor_check_attempted_at",
    attemptCount: "successor_check_attempt_count",
    lastError: "successor_check_last_error",
    discoveredAt: "successor_check_at",
    abandonedAt: "successor_check_abandoned_at",
    source: "successor_check_source",
  },
};

// ---------------------------------------------------------------------------
// Cooldown windows
// ---------------------------------------------------------------------------

/** Days a successful target is considered "fresh" before it can be re-picked. */
export const TOP50_COOLDOWN_DAYS = 7;
export const LONG_TAIL_COOLDOWN_DAYS = 30;

/** Days an abandoned target is held before retry. */
export const ABANDONED_BACKOFF_DAYS = 30;

/** After this many failed attempts the target is marked abandoned. */
export const MAX_ATTEMPTS_BEFORE_ABANDON = 3;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface AttemptRecord {
  target: CooldownTarget;
  attempt_count: number;
  last_attempted_at: string | null;
  last_error: string | null;
  discovered_at: string | null;
  abandoned_at: string | null;
  in_cooldown: boolean;
  cooldown_reason: string | null;
}

export interface RecentEnrichmentSummary {
  memgraph_node_id: string;
  is_top50_brand: boolean;
  last_enriched_at: string | null;
  per_target: AttemptRecord[];
}

/**
 * Record a failed enrichment attempt. Does not touch `last_enriched_at` —
 * that property is the success-side master timestamp and should not advance
 * on failure (otherwise a string of failures would silently push the item
 * out of the Sweeper's selection window).
 *
 * On the 3rd consecutive failure the abandoned marker is set.
 */
export async function touchAttempt(
  nodeId: string | number,
  target: CooldownTarget,
  errorMessage?: string,
): Promise<{ attempt_count: number; abandoned: boolean }> {
  assertTarget(target);
  const props = PROP_NAMES[target];
  const errorTrimmed = errorMessage ? errorMessage.slice(0, 500) : null;

  const cypher = `
MATCH (g:GearItem) WHERE ID(g) = toInteger($nodeId)
SET g.${props.attemptedAt} = datetime(),
    g.${props.attemptCount} = coalesce(g.${props.attemptCount}, 0) + 1,
    g.${props.lastError} = $err
WITH g, g.${props.attemptCount} AS attempts
FOREACH (_ IN CASE WHEN attempts >= ${MAX_ATTEMPTS_BEFORE_ABANDON} THEN [1] ELSE [] END |
  SET g.${props.abandonedAt} = datetime()
)
RETURN g.${props.attemptCount} AS attempts,
       g.${props.abandonedAt} AS abandoned_at
`.trim();

  const session = getWriteSession();
  try {
    const res = await session.run(cypher, {
      nodeId: typeof nodeId === "string" ? Number(nodeId) : nodeId,
      err: errorTrimmed,
    });
    const rec = res.records[0];
    if (!rec) return { attempt_count: 0, abandoned: false };
    return {
      attempt_count: toNumber(rec.get("attempts")),
      abandoned: rec.get("abandoned_at") != null,
    };
  } finally {
    await session.close();
  }
}

/**
 * Record a successful enrichment. Resets attempt counter, clears abandoned
 * marker, stamps `g.<target>_discovered_at` AND the master cooldown
 * `g.last_enriched_at`. Caller is responsible for the actual property write
 * (use `enrichGearItem` tool for that — markSuccess only handles the
 * cooldown bookkeeping).
 */
export async function markSuccess(
  nodeId: string | number,
  target: CooldownTarget,
  source?: string,
): Promise<void> {
  assertTarget(target);
  const props = PROP_NAMES[target];
  const sourceVal = source ?? null;

  const cypher = `
MATCH (g:GearItem) WHERE ID(g) = toInteger($nodeId)
SET g.${props.attemptCount} = 0,
    g.${props.lastError} = null,
    g.${props.abandonedAt} = null,
    g.${props.discoveredAt} = datetime(),
    g.${props.source} = coalesce($src, g.${props.source}),
    g.last_enriched_at = datetime()
`.trim();

  const session = getWriteSession();
  try {
    await session.run(cypher, {
      nodeId: typeof nodeId === "string" ? Number(nodeId) : nodeId,
      src: sourceVal,
    });
  } finally {
    await session.close();
  }
}

/**
 * Read-side cooldown summary for a single item. Used by the
 * `getRecentEnrichments` tool so the agent can decide whether to skip.
 *
 * `in_cooldown` is `true` when `discovered_at` exists AND falls inside the
 * cooldown window (7d top-50 / 30d long-tail), OR when `abandoned_at` exists
 * AND is within the abandoned-backoff window.
 */
export async function getRecentEnrichments(
  nodeId: string | number,
): Promise<RecentEnrichmentSummary | null> {
  const cypher = `
MATCH (g:GearItem) WHERE ID(g) = toInteger($nodeId)
OPTIONAL MATCH (g)-[:PRODUCED_BY]->(b:OutdoorBrand)
RETURN
  ID(g) AS memgraph_node_id,
  coalesce(b.is_top50, false) AS is_top50_brand,
  toString(g.last_enriched_at) AS last_enriched_at,
  toString(g.last_weight_attempted_at) AS w_att, g.weight_attempt_count AS w_cnt,
    g.weight_last_error AS w_err, toString(g.weight_discovered_at) AS w_disc,
    toString(g.weight_abandoned_at) AS w_aban,
  toString(g.last_image_attempted_at) AS i_att, g.image_attempt_count AS i_cnt,
    g.image_last_error AS i_err, toString(g.image_scraped_at) AS i_disc,
    toString(g.image_abandoned_at) AS i_aban,
  toString(g.last_url_attempted_at) AS u_att, g.url_attempt_count AS u_cnt,
    g.url_last_error AS u_err, toString(g.url_discovered_at) AS u_disc,
    toString(g.url_abandoned_at) AS u_aban,
  toString(g.last_product_type_attempted_at) AS pt_att, g.product_type_attempt_count AS pt_cnt,
    g.product_type_last_error AS pt_err, toString(g.product_type_classified_at) AS pt_disc,
    toString(g.product_type_abandoned_at) AS pt_aban,
  toString(g.last_product_family_attempted_at) AS pf_att, g.product_family_attempt_count AS pf_cnt,
    g.product_family_last_error AS pf_err, toString(g.product_family_linked_at) AS pf_disc,
    toString(g.product_family_abandoned_at) AS pf_aban,
  toString(g.last_description_attempted_at) AS d_att, g.description_attempt_count AS d_cnt,
    g.description_last_error AS d_err, toString(g.description_generated_at) AS d_disc,
    toString(g.description_abandoned_at) AS d_aban,
  toString(g.last_insights_attempted_at) AS in_att, g.insights_attempt_count AS in_cnt,
    g.insights_last_error AS in_err, toString(g.insights_extracted_at) AS in_disc,
    toString(g.insights_abandoned_at) AS in_aban,
  toString(g.last_successor_check_attempted_at) AS sc_att, g.successor_check_attempt_count AS sc_cnt,
    g.successor_check_last_error AS sc_err, toString(g.successor_check_at) AS sc_disc,
    toString(g.successor_check_abandoned_at) AS sc_aban
`.trim();

  const session = getReadSession();
  try {
    const res = await session.run(cypher, {
      nodeId: typeof nodeId === "string" ? Number(nodeId) : nodeId,
    });
    const rec = res.records[0];
    if (!rec) return null;

    const isTop50 = Boolean(rec.get("is_top50_brand"));
    const memgraph_node_id = String(toNumber(rec.get("memgraph_node_id")));
    const last_enriched_at = nullableString(rec.get("last_enriched_at"));

    const targetCols: Record<CooldownTarget, [string, string, string, string, string]> = {
      weight_grams: ["w_att", "w_cnt", "w_err", "w_disc", "w_aban"],
      image_url: ["i_att", "i_cnt", "i_err", "i_disc", "i_aban"],
      product_url: ["u_att", "u_cnt", "u_err", "u_disc", "u_aban"],
      product_type: ["pt_att", "pt_cnt", "pt_err", "pt_disc", "pt_aban"],
      product_family: ["pf_att", "pf_cnt", "pf_err", "pf_disc", "pf_aban"],
      description: ["d_att", "d_cnt", "d_err", "d_disc", "d_aban"],
      insights: ["in_att", "in_cnt", "in_err", "in_disc", "in_aban"],
      successor_check: ["sc_att", "sc_cnt", "sc_err", "sc_disc", "sc_aban"],
    };

    const per_target: AttemptRecord[] = COOLDOWN_TARGETS.map((target) => {
      const [attCol, cntCol, errCol, discCol, abanCol] = targetCols[target];
      const attemptedAt = nullableString(rec.get(attCol));
      const attemptCount = toNumber(rec.get(cntCol));
      const lastError = nullableString(rec.get(errCol));
      const discoveredAt = nullableString(rec.get(discCol));
      const abandonedAt = nullableString(rec.get(abanCol));

      const cooldown = computeCooldown({
        target,
        isTop50,
        discoveredAt,
        abandonedAt,
      });

      return {
        target,
        attempt_count: attemptCount,
        last_attempted_at: attemptedAt,
        last_error: lastError,
        discovered_at: discoveredAt,
        abandoned_at: abandonedAt,
        in_cooldown: cooldown.in_cooldown,
        cooldown_reason: cooldown.reason,
      };
    });

    return {
      memgraph_node_id,
      is_top50_brand: isTop50,
      last_enriched_at,
      per_target,
    };
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// Cooldown computation
// ---------------------------------------------------------------------------

function computeCooldown(args: {
  target: CooldownTarget;
  isTop50: boolean;
  discoveredAt: string | null;
  abandonedAt: string | null;
}): { in_cooldown: boolean; reason: string | null } {
  const now = Date.now();

  if (args.abandonedAt) {
    const t = parseDate(args.abandonedAt);
    if (t !== null && now - t < days(ABANDONED_BACKOFF_DAYS)) {
      return {
        in_cooldown: true,
        reason: `abandoned, backoff until ${new Date(t + days(ABANDONED_BACKOFF_DAYS)).toISOString()}`,
      };
    }
  }

  if (args.discoveredAt) {
    const t = parseDate(args.discoveredAt);
    if (t !== null) {
      const window = args.isTop50 ? days(TOP50_COOLDOWN_DAYS) : days(LONG_TAIL_COOLDOWN_DAYS);
      if (now - t < window) {
        return {
          in_cooldown: true,
          reason: `recently discovered (${args.isTop50 ? "top-50" : "long-tail"} ${args.isTop50 ? TOP50_COOLDOWN_DAYS : LONG_TAIL_COOLDOWN_DAYS}d cooldown)`,
        };
      }
    }
  }

  return { in_cooldown: false, reason: null };
}

function days(n: number): number {
  return n * 24 * 60 * 60 * 1000;
}

function parseDate(value: string): number | null {
  // Memgraph datetime → ISO string. Some toString() outputs lack the trailing
  // 'Z', so be defensive.
  const trimmed = value.endsWith("Z") || /[+-]\d\d:\d\d$/.test(value)
    ? value
    : value + "Z";
  const t = Date.parse(trimmed);
  return Number.isFinite(t) ? t : null;
}

function nullableString(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  return String(value);
}
