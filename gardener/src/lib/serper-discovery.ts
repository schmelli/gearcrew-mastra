/**
 * Serper-based product URL discovery helper.
 *
 * Used by `memgraphUrlDiscovery` workflow: given (brand, name) of a GearItem
 * that has no product_url, find the most likely manufacturer/retailer page
 * and return its URL.
 *
 * Strategy:
 *   - Query Google via Serper: "{brand} {name}"
 *   - Filter out blacklisted domains (Amazon, eBay, Walmart, Reddit, YouTube,
 *     pinterest — these are aggregators / discussion, not canonical product
 *     pages)
 *   - Prefer URLs whose hostname contains the brand name (manufacturer site)
 *   - Fall back to first non-blacklisted organic result otherwise
 */

const SERPER_ENDPOINT = "https://google.serper.dev/search";
const REQUEST_TIMEOUT_MS = 10_000;

// These domains aggregate or discuss products but are not canonical product
// pages — og:image scraping from them returns ad banners or stock images.
const BLACKLISTED_HOSTS = new Set<string>([
  "amazon.com",
  "amazon.de",
  "amazon.co.uk",
  "amazon.fr",
  "amazon.it",
  "amazon.es",
  "ebay.com",
  "ebay.de",
  "ebay.co.uk",
  "walmart.com",
  "reddit.com",
  "youtube.com",
  "youtu.be",
  "pinterest.com",
  "pinterest.de",
  "facebook.com",
  "instagram.com",
  "tiktok.com",
  "twitter.com",
  "x.com",
  "wikipedia.org",
  "google.com",
  "bing.com",
  // Generic affiliate / coupon / forum aggregators that surface in top
  // results but never return a clean og:image
  "trustpilot.com",
  "tripadvisor.com",
  "quora.com",
]);

export type DiscoveryOutcome =
  | "manufacturer_match"
  | "retailer_fallback"
  | "no_results"
  | "all_blacklisted"
  | "api_error";

export interface DiscoveryResult {
  url: string | null;
  outcome: DiscoveryOutcome;
  candidate_count: number;
  cost_credits: number;
  error?: string;
}

interface SerperOrganic {
  title?: string;
  link?: string;
  snippet?: string;
}

interface SerperResponse {
  organic?: SerperOrganic[];
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function isBlacklisted(host: string): boolean {
  if (!host) return true;
  if (BLACKLISTED_HOSTS.has(host)) return true;
  // Catch second-level subdomains like "shop.amazon.de" too
  for (const banned of BLACKLISTED_HOSTS) {
    if (host.endsWith(`.${banned}`)) return true;
  }
  return false;
}

/**
 * Compute a brand-match score for a hostname. Higher is better.
 *   3 = brand token appears as the SLD or a clear segment
 *   2 = brand appears anywhere in hostname (case-insensitive)
 *   0 = no brand reference
 */
function brandMatchScore(host: string, brand: string): number {
  if (!host || !brand) return 0;
  const tokens = brand
    .toLowerCase()
    .split(/[\s\-_/&,.()]+/)
    .filter((t) => t.length >= 3); // ignore tiny words like "a", "an"
  if (tokens.length === 0) return 0;

  const hostLower = host.toLowerCase();
  for (const token of tokens) {
    // SLD-level match: hostname is "{token}.de" or "shop.{token}.com" etc.
    const segments = hostLower.split(".");
    if (segments.includes(token)) return 3;
  }
  for (const token of tokens) {
    if (hostLower.includes(token)) return 2;
  }
  return 0;
}

/**
 * Discover a likely product URL via Serper search.
 *
 * Each call costs 1 Serper credit (≈ $0.0003 at the standard tier).
 */
export async function discoverProductUrl(
  brand: string,
  name: string,
): Promise<DiscoveryResult> {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) {
    return {
      url: null,
      outcome: "api_error",
      candidate_count: 0,
      cost_credits: 0,
      error: "SERPER_API_KEY not set",
    };
  }

  const query = `${brand} ${name}`.trim();
  if (!query) {
    return {
      url: null,
      outcome: "no_results",
      candidate_count: 0,
      cost_credits: 0,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let data: SerperResponse;
  try {
    const res = await fetch(SERPER_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": apiKey,
      },
      body: JSON.stringify({ q: query, num: 5 }),
      signal: controller.signal,
    });

    if (!res.ok) {
      return {
        url: null,
        outcome: "api_error",
        candidate_count: 0,
        cost_credits: 1,
        error: `serper_${res.status}`,
      };
    }
    data = (await res.json()) as SerperResponse;
  } catch (err) {
    return {
      url: null,
      outcome: "api_error",
      candidate_count: 0,
      cost_credits: 1,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }

  const organic = (data.organic ?? []).filter(
    (r): r is { link: string; title?: string; snippet?: string } =>
      typeof r.link === "string" && r.link.length > 0,
  );

  if (organic.length === 0) {
    return {
      url: null,
      outcome: "no_results",
      candidate_count: 0,
      cost_credits: 1,
    };
  }

  const ranked = organic
    .map((r) => {
      const host = hostnameOf(r.link);
      return {
        url: r.link,
        host,
        blacklisted: isBlacklisted(host),
        brandScore: brandMatchScore(host, brand),
      };
    })
    .filter((r) => !r.blacklisted)
    .sort((a, b) => b.brandScore - a.brandScore);

  if (ranked.length === 0) {
    return {
      url: null,
      outcome: "all_blacklisted",
      candidate_count: organic.length,
      cost_credits: 1,
    };
  }

  const top = ranked[0]!;
  return {
    url: top.url,
    outcome: top.brandScore >= 2 ? "manufacturer_match" : "retailer_fallback",
    candidate_count: ranked.length,
    cost_credits: 1,
  };
}
