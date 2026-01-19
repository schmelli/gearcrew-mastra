/**
 * T066: Firecrawl Response Cache
 * Caches web research results to reduce API costs
 */

import { createHash } from 'crypto';
import { getLibSQLClient } from '@/mastra/index';
import type { GearSpecs } from './web-search';

// Cache TTL in days (default: 7 days)
const CACHE_TTL_DAYS = parseInt(process.env.FIRECRAWL_CACHE_TTL_DAYS ?? '7', 10);

// Enable/disable cache
const CACHE_ENABLED = process.env.FIRECRAWL_CACHE_ENABLED !== 'false';

export interface CachedGearResult {
  specs: GearSpecs | null;
  sources: string[];
  confidence: number;
  cachedAt: string;
}

/**
 * Generate a deterministic hash for a query
 */
function generateQueryHash(gearName: string, brand?: string): string {
  const normalizedQuery = `${gearName.toLowerCase().trim()}|${(brand ?? '').toLowerCase().trim()}`;
  return createHash('sha256').update(normalizedQuery).digest('hex').substring(0, 32);
}

/**
 * Get cached gear search result
 */
export async function getCachedGearResult(
  gearName: string,
  brand?: string
): Promise<CachedGearResult | null> {
  if (!CACHE_ENABLED) {
    return null;
  }

  const db = getLibSQLClient();
  const queryHash = generateQueryHash(gearName, brand);

  try {
    const result = await db.execute({
      sql: `
        SELECT response_json, source_urls, confidence, created_at
        FROM firecrawl_cache
        WHERE query_hash = ? AND expires_at > datetime('now')
      `,
      args: [queryHash],
    });

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0]!;
    const specs = JSON.parse(row.response_json as string) as GearSpecs | null;
    const sources = row.source_urls ? JSON.parse(row.source_urls as string) : [];

    console.log(`[FirecrawlCache] Cache HIT for "${gearName}" (${brand ?? 'no brand'})`);

    return {
      specs,
      sources,
      confidence: (row.confidence as number) ?? 0,
      cachedAt: row.created_at as string,
    };
  } catch (error) {
    console.error('[FirecrawlCache] Error reading cache:', error);
    return null;
  }
}

/**
 * Store gear search result in cache
 */
export async function setCachedGearResult(
  gearName: string,
  brand: string | undefined,
  specs: GearSpecs | null,
  sources: string[]
): Promise<void> {
  if (!CACHE_ENABLED) {
    return;
  }

  const db = getLibSQLClient();
  const queryHash = generateQueryHash(gearName, brand);
  const queryText = brand ? `${brand} ${gearName}` : gearName;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CACHE_TTL_DAYS * 24 * 60 * 60 * 1000);
  const id = `fc-${queryHash}-${now.getTime()}`;

  try {
    await db.execute({
      sql: `
        INSERT OR REPLACE INTO firecrawl_cache
        (id, query_hash, query_text, response_json, source_urls, confidence, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        id,
        queryHash,
        queryText,
        JSON.stringify(specs),
        JSON.stringify(sources),
        specs?.confidence ?? 0,
        now.toISOString(),
        expiresAt.toISOString(),
      ],
    });

    console.log(`[FirecrawlCache] Cached result for "${gearName}" (TTL: ${CACHE_TTL_DAYS} days)`);
  } catch (error) {
    console.error('[FirecrawlCache] Error writing cache:', error);
  }
}

/**
 * Clean up expired cache entries
 */
export async function cleanupExpiredCache(): Promise<number> {
  const db = getLibSQLClient();

  try {
    const result = await db.execute({
      sql: `DELETE FROM firecrawl_cache WHERE expires_at <= datetime('now')`,
      args: [],
    });

    const deleted = result.rowsAffected;
    if (deleted > 0) {
      console.log(`[FirecrawlCache] Cleaned up ${deleted} expired entries`);
    }
    return deleted;
  } catch (error) {
    console.error('[FirecrawlCache] Error cleaning cache:', error);
    return 0;
  }
}

/**
 * Get cache statistics
 */
export async function getCacheStats(): Promise<{
  totalEntries: number;
  validEntries: number;
  expiredEntries: number;
  oldestEntry: string | null;
  newestEntry: string | null;
  averageConfidence: number;
}> {
  const db = getLibSQLClient();

  try {
    const statsResult = await db.execute({
      sql: `
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN expires_at > datetime('now') THEN 1 ELSE 0 END) as valid,
          SUM(CASE WHEN expires_at <= datetime('now') THEN 1 ELSE 0 END) as expired,
          MIN(created_at) as oldest,
          MAX(created_at) as newest,
          AVG(confidence) as avg_confidence
        FROM firecrawl_cache
      `,
      args: [],
    });

    const row = statsResult.rows[0];
    return {
      totalEntries: (row?.total as number) ?? 0,
      validEntries: (row?.valid as number) ?? 0,
      expiredEntries: (row?.expired as number) ?? 0,
      oldestEntry: (row?.oldest as string) ?? null,
      newestEntry: (row?.newest as string) ?? null,
      averageConfidence: (row?.avg_confidence as number) ?? 0,
    };
  } catch (error) {
    console.error('[FirecrawlCache] Error getting stats:', error);
    return {
      totalEntries: 0,
      validEntries: 0,
      expiredEntries: 0,
      oldestEntry: null,
      newestEntry: null,
      averageConfidence: 0,
    };
  }
}

/**
 * Clear entire cache (for testing/maintenance)
 */
export async function clearCache(): Promise<number> {
  const db = getLibSQLClient();

  try {
    const result = await db.execute({
      sql: `DELETE FROM firecrawl_cache`,
      args: [],
    });

    const deleted = result.rowsAffected;
    console.log(`[FirecrawlCache] Cleared ${deleted} entries`);
    return deleted;
  } catch (error) {
    console.error('[FirecrawlCache] Error clearing cache:', error);
    return 0;
  }
}

export default {
  get: getCachedGearResult,
  set: setCachedGearResult,
  cleanup: cleanupExpiredCache,
  stats: getCacheStats,
  clear: clearCache,
  isEnabled: () => CACHE_ENABLED,
};
