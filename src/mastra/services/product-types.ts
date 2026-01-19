/**
 * ProductTypes Service
 * Fetches ProductTypes (Level 3 categories) from Gearshack Supabase database
 */

import { getLibSQLClient } from '@/mastra/index';

// Supabase configuration
const SUPABASE_URL = process.env.SUPABASE_URL ?? 'https://pxtvbgilzzppnbienmot.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

// Cache TTL in hours (default: 24 hours)
const CACHE_TTL_HOURS = parseInt(process.env.PRODUCT_TYPES_CACHE_HOURS ?? '24', 10);

// In-memory cache for fast access
let memoryCache: ProductType[] | null = null;
let memoryCacheExpiry: number = 0;

export interface ProductType {
  id: string;
  label: string;
  slug: string;
  parentId: string | null;
}

interface SupabaseCategory {
  id: string;
  label: string;
  slug: string;
  parent_id: string | null;
}

/**
 * Fetch ProductTypes from Supabase REST API
 */
async function fetchFromSupabase(): Promise<ProductType[]> {
  if (!SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');
  }

  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/categories?level=eq.3&select=id,label,slug,parent_id`,
    {
      headers: {
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Supabase API error: ${response.status} - ${errorText}`);
  }

  const categories: SupabaseCategory[] = await response.json();

  return categories.map((cat) => ({
    id: cat.id,
    label: cat.label,
    slug: cat.slug,
    parentId: cat.parent_id,
  }));
}

/**
 * Get ProductTypes from LibSQL cache
 */
async function getFromLibSQLCache(): Promise<ProductType[] | null> {
  const db = getLibSQLClient();

  try {
    const result = await db.execute({
      sql: `
        SELECT data, fetched_at
        FROM config_cache
        WHERE key = 'product_types'
      `,
      args: [],
    });

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0]!;
    const fetchedAt = new Date(row.fetched_at as string);
    const now = new Date();
    const hoursSinceFetch = (now.getTime() - fetchedAt.getTime()) / (1000 * 60 * 60);

    if (hoursSinceFetch > CACHE_TTL_HOURS) {
      console.log('[ProductTypes] LibSQL cache expired');
      return null;
    }

    console.log(`[ProductTypes] Loaded from LibSQL cache (${Math.round(hoursSinceFetch)}h old)`);
    return JSON.parse(row.data as string);
  } catch (error) {
    console.error('[ProductTypes] Error reading LibSQL cache:', error);
    return null;
  }
}

/**
 * Store ProductTypes in LibSQL cache
 */
async function saveToLibSQLCache(productTypes: ProductType[]): Promise<void> {
  const db = getLibSQLClient();

  try {
    await db.execute({
      sql: `
        INSERT OR REPLACE INTO config_cache (key, data, fetched_at)
        VALUES (?, ?, ?)
      `,
      args: ['product_types', JSON.stringify(productTypes), new Date().toISOString()],
    });
    console.log(`[ProductTypes] Saved ${productTypes.length} types to LibSQL cache`);
  } catch (error) {
    console.error('[ProductTypes] Error writing LibSQL cache:', error);
  }
}

/**
 * Get all ProductTypes (with caching)
 * Uses a three-tier cache: memory -> LibSQL -> Supabase API
 */
export async function getProductTypes(): Promise<ProductType[]> {
  const now = Date.now();

  // Check memory cache first
  if (memoryCache && memoryCacheExpiry > now) {
    console.log('[ProductTypes] Using memory cache');
    return memoryCache;
  }

  // Check LibSQL cache
  const libsqlCached = await getFromLibSQLCache();
  if (libsqlCached) {
    memoryCache = libsqlCached;
    memoryCacheExpiry = now + CACHE_TTL_HOURS * 60 * 60 * 1000;
    return libsqlCached;
  }

  // Fetch from Supabase
  console.log('[ProductTypes] Fetching from Supabase...');
  const productTypes = await fetchFromSupabase();
  console.log(`[ProductTypes] Fetched ${productTypes.length} ProductTypes from Supabase`);

  // Update caches
  memoryCache = productTypes;
  memoryCacheExpiry = now + CACHE_TTL_HOURS * 60 * 60 * 1000;
  await saveToLibSQLCache(productTypes);

  return productTypes;
}

/**
 * Find ProductType by exact name match
 */
export async function findProductTypeByName(name: string): Promise<ProductType | null> {
  const productTypes = await getProductTypes();
  const normalizedName = name.toLowerCase().trim();

  return productTypes.find((pt) => pt.label.toLowerCase() === normalizedName) ?? null;
}

/**
 * Find ProductType by slug
 */
export async function findProductTypeBySlug(slug: string): Promise<ProductType | null> {
  const productTypes = await getProductTypes();
  return productTypes.find((pt) => pt.slug === slug) ?? null;
}

/**
 * Find ProductTypes by fuzzy matching
 * Returns matches sorted by relevance
 */
export async function findProductTypesByFuzzyMatch(
  query: string,
  limit = 5
): Promise<Array<{ productType: ProductType; score: number }>> {
  const productTypes = await getProductTypes();
  const normalizedQuery = query.toLowerCase().trim();
  const queryWords = normalizedQuery.split(/\s+/);

  const scored = productTypes.map((pt) => {
    const label = pt.label.toLowerCase();
    let score = 0;

    // Exact match gets highest score
    if (label === normalizedQuery) {
      score = 1.0;
    }
    // Contains full query
    else if (label.includes(normalizedQuery)) {
      score = 0.8;
    }
    // Check individual words
    else {
      const matchedWords = queryWords.filter((word) => label.includes(word));
      score = (matchedWords.length / queryWords.length) * 0.6;
    }

    // Bonus for slug match
    if (pt.slug.includes(normalizedQuery.replace(/\s+/g, '-'))) {
      score += 0.1;
    }

    return { productType: pt, score };
  });

  return scored
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Clear all caches (for testing/maintenance)
 */
export async function clearProductTypesCache(): Promise<void> {
  memoryCache = null;
  memoryCacheExpiry = 0;

  const db = getLibSQLClient();
  try {
    await db.execute({
      sql: `DELETE FROM config_cache WHERE key = 'product_types'`,
      args: [],
    });
    console.log('[ProductTypes] Cache cleared');
  } catch (error) {
    console.error('[ProductTypes] Error clearing cache:', error);
  }
}

/**
 * Preload ProductTypes into cache (for workflow startup)
 */
export async function preloadProductTypes(): Promise<number> {
  const productTypes = await getProductTypes();
  return productTypes.length;
}

export default {
  getAll: getProductTypes,
  findByName: findProductTypeByName,
  findBySlug: findProductTypeBySlug,
  findByFuzzyMatch: findProductTypesByFuzzyMatch,
  preload: preloadProductTypes,
  clearCache: clearProductTypesCache,
};
