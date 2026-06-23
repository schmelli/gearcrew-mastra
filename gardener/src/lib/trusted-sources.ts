/**
 * Trusted review sources — single source of truth for domain trust.
 *
 * Backed by the Supabase `trusted_review_sources` table (project
 * pxtvbgilzzppnbienmot). Replaces three previously-scattered hardcoded lists:
 *   - gardener/src/workflows/weight-verification.ts (TRUSTED_DOMAINS)
 *   - src/mastra/agents/researcher-v2.ts (LEGACY, decommissioned)
 *   - src/mastra/agents/researcher.ts (LEGACY, decommissioned)
 *
 * Reads active rows via the existing service-role client (getSupabase()).
 * Results are cached in-memory for TTL_MS so repeated calls within a single
 * workflow run do not re-query Supabase.
 *
 * RESILIENT FALLBACK: if the DB read throws or returns no rows, we console.warn
 * and fall back to DEFAULT_TRUSTED_SOURCES (the 8 seeded rows) so enrichment
 * never breaks on a transient DB error.
 */

import { getSupabase } from "./supabase.js";

export type TrustedSourceCategory =
  | "review"
  | "retailer"
  | "community"
  | "brand"
  | "other";

export interface TrustedSource {
  domain: string;
  name: string;
  /** 0.0 .. 1.0 */
  trustWeight: number;
  category: TrustedSourceCategory;
  active: boolean;
  /**
   * On-site search URL with a `{query}` placeholder (substitute the
   * URL-encoded search term). `null` = no native on-site search; callers fall
   * back to a Serper `site:` query. Lets the pipeline curl the site search and
   * hand firecrawl only the result set instead of scraping the whole site.
   */
  searchUrlTemplate: string | null;
}

/**
 * Fallback used only when the DB read fails or returns empty. Mirrors the 8
 * rows seeded into `trusted_review_sources` so behavior degrades gracefully
 * rather than disabling trust entirely.
 */
export const DEFAULT_TRUSTED_SOURCES: readonly TrustedSource[] = [
  { domain: "outdoorgearlab.com", name: "OutdoorGearLab", trustWeight: 0.9, category: "review", active: true, searchUrlTemplate: null },
  { domain: "switchbacktravel.com", name: "Switchback Travel", trustWeight: 0.85, category: "review", active: true, searchUrlTemplate: null },
  { domain: "cleverhiker.com", name: "CleverHiker", trustWeight: 0.85, category: "review", active: true, searchUrlTemplate: null },
  { domain: "sectionhiker.com", name: "SectionHiker", trustWeight: 0.8, category: "review", active: true, searchUrlTemplate: null },
  { domain: "trailspace.com", name: "Trailspace", trustWeight: 0.8, category: "community", active: true, searchUrlTemplate: null },
  { domain: "gearjunkie.com", name: "GearJunkie", trustWeight: 0.75, category: "review", active: true, searchUrlTemplate: "https://gearjunkie.com/?s={query}" },
  { domain: "rei.com", name: "REI", trustWeight: 0.7, category: "retailer", active: true, searchUrlTemplate: null },
  { domain: "backcountry.com", name: "Backcountry", trustWeight: 0.7, category: "retailer", active: true, searchUrlTemplate: null },
] as const;

const TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry {
  sources: TrustedSource[];
  fetchedAt: number;
}

let cache: CacheEntry | null = null;

const VALID_CATEGORIES: ReadonlySet<string> = new Set<TrustedSourceCategory>([
  "review",
  "retailer",
  "community",
  "brand",
  "other",
]);

function toCategory(value: unknown): TrustedSourceCategory {
  return typeof value === "string" && VALID_CATEGORIES.has(value)
    ? (value as TrustedSourceCategory)
    : "other";
}

interface TrustedReviewSourceRow {
  domain?: string | null;
  name?: string | null;
  trust_weight?: number | string | null;
  category?: string | null;
  active?: boolean | null;
  search_url_template?: string | null;
}

function mapRow(row: TrustedReviewSourceRow): TrustedSource | null {
  const domain = normalizeDomain(row.domain ?? "");
  if (!domain) return null;

  const rawWeight =
    typeof row.trust_weight === "string"
      ? Number.parseFloat(row.trust_weight)
      : row.trust_weight;
  const trustWeight =
    typeof rawWeight === "number" && Number.isFinite(rawWeight)
      ? Math.min(1, Math.max(0, rawWeight))
      : 0;

  return {
    domain,
    name: row.name ?? domain,
    trustWeight,
    category: toCategory(row.category),
    active: row.active ?? true,
    searchUrlTemplate: row.search_url_template ?? null,
  };
}

/**
 * Normalize a URL or bare domain to a lowercase hostname without scheme, path,
 * port, or leading `www.`. Returns "" when nothing usable can be extracted.
 *
 * Examples:
 *   "https://www.REI.com/product/123" -> "rei.com"
 *   "outdoorgearlab.com"              -> "outdoorgearlab.com"
 *   "serper:answerBox"                -> "" (sentinel, never trusted)
 */
export function normalizeDomain(urlOrDomain: string): string {
  let host = (urlOrDomain ?? "").trim().toLowerCase();
  if (!host) return "";

  // Strip scheme if present.
  const schemeIdx = host.indexOf("://");
  if (schemeIdx !== -1) {
    host = host.slice(schemeIdx + 3);
  } else if (host.includes(":") && !host.includes("/") && !host.includes(".")) {
    // Sentinel values like "serper:answerBox" — no dot, has colon → not a domain.
    return "";
  }

  // Drop path / query / fragment.
  host = host.split("/")[0].split("?")[0].split("#")[0];
  // Drop credentials (user:pass@host).
  const atIdx = host.lastIndexOf("@");
  if (atIdx !== -1) host = host.slice(atIdx + 1);
  // Drop port.
  host = host.split(":")[0];
  // Drop leading www.
  if (host.startsWith("www.")) host = host.slice(4);

  // A real domain must contain a dot.
  return host.includes(".") ? host : "";
}

/**
 * Domain-matching semantics ported from weight-verification.ts isTrustedDomain:
 * a candidate matches a trusted domain when it is an exact match OR a
 * (second-level or deeper) subdomain of it. Prevents "notrei.com" from matching
 * "rei.com".
 */
function hostMatchesDomain(host: string, trustedDomain: string): boolean {
  return host === trustedDomain || host.endsWith("." + trustedDomain);
}

async function loadFromDb(): Promise<TrustedSource[]> {
  const supa = getSupabase();
  const { data, error } = await supa
    .from("trusted_review_sources")
    .select("domain, name, trust_weight, category, active, search_url_template")
    .eq("active", true);

  if (error) {
    throw new Error(`[trusted-sources] select failed: ${error.message}`);
  }

  const rows = (data ?? []) as TrustedReviewSourceRow[];
  const sources: TrustedSource[] = [];
  for (const row of rows) {
    const mapped = mapRow(row);
    if (mapped) sources.push(mapped);
  }
  return sources;
}

/**
 * Returns active trusted sources, cached for TTL_MS. Falls back to
 * DEFAULT_TRUSTED_SOURCES (with a console.warn) on any DB error or empty result.
 */
export async function getTrustedSources(): Promise<TrustedSource[]> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < TTL_MS) {
    return cache.sources;
  }

  try {
    const sources = await loadFromDb();
    if (sources.length === 0) {
      console.warn(
        "[trusted-sources] trusted_review_sources returned no active rows — using DEFAULT_TRUSTED_SOURCES fallback.",
      );
      const fallback = [...DEFAULT_TRUSTED_SOURCES];
      cache = { sources: fallback, fetchedAt: now };
      return fallback;
    }
    cache = { sources, fetchedAt: now };
    return sources;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[trusted-sources] DB read failed (${message}) — using DEFAULT_TRUSTED_SOURCES fallback.`,
    );
    const fallback = [...DEFAULT_TRUSTED_SOURCES];
    // Cache the fallback so a transient outage doesn't hammer the DB every call
    // within the TTL window.
    cache = { sources: fallback, fetchedAt: now };
    return fallback;
  }
}

/** Active trusted domains (bare, normalized hostnames). */
export async function getTrustedDomains(): Promise<string[]> {
  const sources = await getTrustedSources();
  return sources.map((s) => s.domain);
}

/**
 * Trust weight (0.0 .. 1.0) for a URL or bare domain. Returns 0 when the input
 * does not match any active trusted source. When multiple trusted domains match
 * (e.g. exact + parent), the highest weight wins.
 */
export async function getTrustWeight(urlOrDomain: string): Promise<number> {
  const host = normalizeDomain(urlOrDomain);
  if (!host) return 0;

  const sources = await getTrustedSources();
  let best = 0;
  for (const s of sources) {
    if (hostMatchesDomain(host, s.domain) && s.trustWeight > best) {
      best = s.trustWeight;
    }
  }
  return best;
}

/** True when the URL or bare domain matches an active trusted source. */
export async function isTrustedDomain(urlOrDomain: string): Promise<boolean> {
  const host = normalizeDomain(urlOrDomain);
  if (!host) return false;

  const sources = await getTrustedSources();
  return sources.some((s) => hostMatchesDomain(host, s.domain));
}

/**
 * Synchronous domain match against an explicit domain list. Preserves the exact
 * matching semantics of weight-verification.ts's original isTrustedDomain so
 * call sites that already hold a resolved domain list (e.g. from
 * getTrustedDomains()) keep identical behavior. Accepts a URL or a bare domain.
 */
export function matchesTrustedDomain(
  urlOrDomain: string,
  trustedDomains: string[],
): boolean {
  const host = normalizeDomain(urlOrDomain);
  if (!host) return false;
  return trustedDomains.some((d) => hostMatchesDomain(host, d));
}

/**
 * Build a ready-to-fetch on-site search URL for a trusted source, substituting
 * the URL-encoded `query` for the `{query}` placeholder in its
 * `searchUrlTemplate`. Returns `null` when the matched source has no native
 * search template (caller should fall back to a Serper `site:<domain>` query)
 * or when the input matches no active trusted source.
 */
export async function buildSearchUrl(
  urlOrDomain: string,
  query: string,
): Promise<string | null> {
  const host = normalizeDomain(urlOrDomain);
  if (!host) return null;
  const sources = await getTrustedSources();
  const match = sources.find((s) => hostMatchesDomain(host, s.domain));
  if (!match?.searchUrlTemplate) return null;
  return match.searchUrlTemplate.replace(/\{query\}/g, encodeURIComponent(query));
}

/** Clears the in-memory cache. Primarily for tests and forced refresh. */
export function clearTrustedSourcesCache(): void {
  cache = null;
}
