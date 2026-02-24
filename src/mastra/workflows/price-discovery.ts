/**
 * Price Discovery Workflow
 *
 * Triggered by Gearshack when a gear item is created without manufacturer_price.
 * 1. Scrapes product_url for manufacturer price
 * 2. Web-searches for reseller prices (up to 3)
 * 3. Writes PricePoint nodes to MemGraph (price history)
 * 4. Writes-back to Supabase (gear_items + reseller_price_results)
 *
 * Env vars required (add to .env + docker-compose.yml):
 *   SUPABASE_URL              - Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY - Supabase service role key
 */

import { v4 as uuidv4 } from 'uuid';
import { getMemgraphClient } from '@/lib/memgraph-client';
import { getLibSQLClient } from '@/mastra/index';
import { FirecrawlClient } from '@/mastra/tools/firecrawl/web-search';
import { getScheduler, SCHEDULES } from '@/lib/scheduler';

// ============================================================================
// Types
// ============================================================================

export interface PriceDiscoveryParams {
  gearItemId: string;
  brand: string | null;
  name: string;
  productUrl: string | null;
  /** BCP-47 locale code, e.g. 'de' or 'en'. Drives search language and query phrasing. */
  locale?: string;
  /** ISO 4217 preferred currency, e.g. 'EUR'. Used as extraction hint when no symbol is present. */
  currency?: string;
  /** ISO 3166-1 alpha-2 country code, e.g. 'DE'. Biases search results toward local shops. */
  country?: string;
}

export interface DiscoveredPrice {
  value: number;
  currency: string;
}

export interface DiscoveredReseller {
  name: string;
  url: string;
  price: number;
  currency: string;
}

export interface PriceDiscoveryResult {
  runId: string;
  status: 'completed' | 'failed';
  manufacturerPrice: DiscoveredPrice | null;
  resellers: DiscoveredReseller[];
  error?: string;
  duration: number;
}

// ============================================================================
// Price Extraction Helpers
// ============================================================================

/**
 * Extract price from scraped markdown content using common patterns.
 * @param preferredCurrency ISO 4217 hint — used as fallback when no currency symbol is found.
 */
function extractPriceFromMarkdown(markdown: string, preferredCurrency = 'USD'): DiscoveredPrice | null {
  type PricePattern = { regex: RegExp; currency: string };
  const patterns: PricePattern[] = [
    { regex: /€\s*(\d{1,5}(?:[.,]\d{2})?)/, currency: 'EUR' },
    { regex: /(\d{1,5}(?:[.,]\d{2})?)\s*€/, currency: 'EUR' },
    { regex: /£\s*(\d{1,5}(?:[.,]\d{2})?)/, currency: 'GBP' },
    { regex: /\$\s*(\d{1,5}(?:[.,]\d{2})?)/, currency: 'USD' },
    { regex: /(?:Price|MSRP|RRP|UVP|Preis)[\s:$€£]*(\d{1,5}(?:[.,]\d{2})?)/i, currency: preferredCurrency },
    { regex: /(\d{1,5}(?:[.,]\d{2})?)\s*(?:EUR|USD|GBP|CHF)/i, currency: preferredCurrency },
  ];

  for (const { regex, currency } of patterns) {
    const match = markdown.match(regex);
    if (match) {
      const raw = match[1].replace(',', '.');
      const value = parseFloat(raw);
      if (value > 1 && value < 100_000) {
        // Re-detect currency from surrounding symbols for accuracy
        const detectedCurrency =
          markdown.includes('€') ? 'EUR' :
          markdown.includes('£') ? 'GBP' :
          markdown.includes('CHF') ? 'CHF' :
          currency;
        return { value, currency: detectedCurrency };
      }
    }
  }
  return null;
}

// ============================================================================
// Step 1: Scrape Manufacturer Price
// ============================================================================

async function scrapeManufacturerPrice(productUrl: string, preferredCurrency?: string): Promise<DiscoveredPrice | null> {
  try {
    const client = new FirecrawlClient();
    const result = await client.scrape(productUrl, { onlyMainContent: true });
    if (!result.success || !result.data.markdown) return null;
    return extractPriceFromMarkdown(result.data.markdown, preferredCurrency);
  } catch (error) {
    console.warn('[PriceDiscovery] Manufacturer scrape failed:', error);
    return null;
  }
}

// ============================================================================
// Step 2: Search Reseller Prices
// ============================================================================

interface SerperShoppingItem {
  title: string;
  link: string;
  source?: string;
  price?: string;
}

/**
 * Parse Serper Shopping price strings like "€ 549,00", "$549.00", "£ 429.00".
 */
function parseSerperPrice(priceStr: string): DiscoveredPrice | null {
  const currencySymbols: [string, string][] = [
    ['CHF', 'CHF'],
    ['€', 'EUR'],
    ['£', 'GBP'],
    ['$', 'USD'],
  ];

  for (const [symbol, currency] of currencySymbols) {
    if (!priceStr.includes(symbol)) continue;
    const numStr = priceStr.replace(symbol, '').trim();
    // Handle European format "549,00" vs US format "549.00"
    const normalized = /\d,\d{2}$/.test(numStr)
      ? numStr.replace(/\./g, '').replace(',', '.')
      : numStr.replace(/[^0-9.]/g, '');
    const value = parseFloat(normalized);
    if (value > 1 && value < 100_000) return { value, currency };
  }
  return null;
}

/**
 * Geo-targeted reseller search via Serper Shopping API.
 * Returns structured prices directly from Google Shopping — no page scraping needed.
 */
async function searchResellerPricesSerper(
  brand: string | null,
  name: string,
  country = 'de',
  locale = 'de',
): Promise<DiscoveredReseller[]> {
  const serperApiKey = process.env.SERPER_API_KEY;
  if (!serperApiKey) return [];

  try {
    const query = `${brand ? brand + ' ' : ''}${name}`;
    const res = await fetch('https://google.serper.dev/shopping', {
      method: 'POST',
      headers: { 'X-API-KEY': serperApiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, gl: country.toLowerCase(), hl: locale, num: 5 }),
    });

    if (!res.ok) {
      console.warn('[PriceDiscovery] Serper Shopping returned', res.status);
      return [];
    }

    const data = await res.json() as { shopping?: SerperShoppingItem[] };
    if (!data.shopping || data.shopping.length === 0) return [];

    const resellers: DiscoveredReseller[] = [];
    for (const item of data.shopping.slice(0, 3)) {
      if (!item.link || !item.price) continue;
      const price = parseSerperPrice(item.price);
      if (!price) continue;

      let domain: string;
      try { domain = new URL(item.link).hostname.replace(/^www\./, ''); } catch { domain = item.link; }

      resellers.push({
        name: item.source ?? domain,
        url: item.link,
        price: price.value,
        currency: price.currency,
      });
    }

    return resellers;
  } catch (error) {
    console.warn('[PriceDiscovery] Serper Shopping search failed:', error);
    return [];
  }
}

/**
 * Search reseller prices: Serper Shopping (geo-targeted) with Firecrawl fallback.
 */
async function searchResellerPrices(
  brand: string | null,
  name: string,
  locale = 'en',
  preferredCurrency = 'USD',
  country = 'us',
): Promise<DiscoveredReseller[]> {
  // Primary: Serper Shopping — structured prices, geo-targeted, no scraping
  const serperResults = await searchResellerPricesSerper(brand, name, country, locale);
  if (serperResults.length > 0) return serperResults;

  // Fallback: Firecrawl web search + markdown price extraction
  console.info('[PriceDiscovery] Serper returned no results, falling back to Firecrawl');
  try {
    const brandPrefix = brand ? `${brand} ` : '';
    const query = locale === 'de'
      ? `${brandPrefix}${name} kaufen outdoor shop`
      : `buy ${brandPrefix}${name} outdoor gear shop`;
    const client = new FirecrawlClient();
    const searchResult = await client.search(query, {
      limit: 5,
      scrapeOptions: { formats: ['markdown'] },
    });

    if (!searchResult.success || searchResult.results.length === 0) return [];

    const resellers: DiscoveredReseller[] = [];
    for (const result of searchResult.results.slice(0, 3)) {
      if (!result.url || !result.markdown) continue;
      const price = extractPriceFromMarkdown(result.markdown, preferredCurrency);
      if (!price) continue;

      let storeName = result.title ?? '';
      if (!storeName) {
        try { storeName = new URL(result.url).hostname.replace(/^www\./, ''); } catch { storeName = result.url; }
      }
      resellers.push({ name: storeName, url: result.url, price: price.value, currency: price.currency });
    }
    return resellers;
  } catch (error) {
    console.warn('[PriceDiscovery] Firecrawl fallback search failed:', error);
    return [];
  }
}

// ============================================================================
// Step 3: Write to MemGraph
// ============================================================================

async function writeToMemGraph(
  gearItemId: string,
  brand: string | null,
  name: string,
  manufacturerPrice: DiscoveredPrice | null,
  productUrl: string | null,
  resellers: DiscoveredReseller[]
): Promise<void> {
  const db = getMemgraphClient();

  try {
    await db.query(
      'MERGE (g:GearItem {gearshack_id: $id}) SET g.brand = $brand, g.name = $name',
      { id: gearItemId, brand: brand ?? null, name }
    );

    await db.query(
      'MATCH (g:GearItem {gearshack_id: $id})-[r:HAS_PRICE]->(p:PricePoint) WHERE p.is_current = true SET p.is_current = false',
      { id: gearItemId }
    );

    if (manufacturerPrice) {
      await db.query(
        `MATCH (g:GearItem {gearshack_id: $id})
         CREATE (p:PricePoint {
           value: $value, currency: $currency, type: 'manufacturer',
           reseller_name: null, source_url: $url,
           discovered_at: localDateTime(), is_current: true
         })
         CREATE (g)-[:HAS_PRICE]->(p)`,
        { id: gearItemId, value: manufacturerPrice.value, currency: manufacturerPrice.currency, url: productUrl }
      );
    }

    for (const reseller of resellers) {
      await db.query(
        `MATCH (g:GearItem {gearshack_id: $id})
         CREATE (p:PricePoint {
           value: $value, currency: $currency, type: 'reseller',
           reseller_name: $rname, source_url: $url,
           discovered_at: localDateTime(), is_current: true
         })
         CREATE (g)-[:HAS_PRICE]->(p)`,
        { id: gearItemId, value: reseller.price, currency: reseller.currency, rname: reseller.name, url: reseller.url }
      );
    }
  } catch (error) {
    console.warn('[PriceDiscovery] MemGraph write failed (non-fatal):', error);
  }
}

// ============================================================================
// Step 4: Write-back to Supabase
// ============================================================================

async function writeBackToSupabase(
  gearItemId: string,
  manufacturerPrice: DiscoveredPrice | null,
  resellers: DiscoveredReseller[]
): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    console.warn('[PriceDiscovery] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not configured — skipping write-back');
    return;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    Prefer: 'return=minimal',
  };

  if (manufacturerPrice) {
    try {
      const res = await fetch(
        `${supabaseUrl}/rest/v1/gear_items?id=eq.${encodeURIComponent(gearItemId)}&manufacturer_price=is.null`,
        {
          method: 'PATCH',
          headers,
          body: JSON.stringify({
            manufacturer_price: manufacturerPrice.value,
            manufacturer_currency: manufacturerPrice.currency,
          }),
        }
      );
      if (!res.ok) {
        console.warn('[PriceDiscovery] Supabase gear_items PATCH returned', res.status);
      }
    } catch (error) {
      console.warn('[PriceDiscovery] Supabase manufacturer price update failed:', error);
    }
  }

  for (const reseller of resellers) {
    try {
      let domain: string;
      try {
        domain = new URL(reseller.url).hostname;
      } catch {
        domain = reseller.url;
      }
      const websiteUrl = `https://${domain}`;

      // First: look up existing reseller by website_url
      let resellerId: string | null = null;
      const lookupRes = await fetch(
        `${supabaseUrl}/rest/v1/resellers?website_url=eq.${encodeURIComponent(websiteUrl)}&select=id&limit=1`,
        { headers }
      );
      if (lookupRes.ok) {
        const existing = await lookupRes.json() as Array<{ id: string }>;
        resellerId = existing[0]?.id ?? null;
      }

      // If not found: create with all required fields
      if (!resellerId) {
        const createRes = await fetch(
          `${supabaseUrl}/rest/v1/resellers`,
          {
            method: 'POST',
            headers: { ...headers, Prefer: 'return=representation' },
            body: JSON.stringify({
              name: reseller.name,
              website_url: websiteUrl,
              reseller_type: 'online',
              is_active: true,
            }),
          }
        );
        if (!createRes.ok) {
          console.warn('[PriceDiscovery] Reseller create failed:', createRes.status);
          continue;
        }
        const created = await createRes.json() as Array<{ id: string }>;
        resellerId = created[0]?.id ?? null;
      }

      if (!resellerId) continue;

      await fetch(
        `${supabaseUrl}/rest/v1/reseller_price_results`,
        {
          method: 'POST',
          headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify({
            gear_item_id: gearItemId,
            reseller_id: resellerId,
            price_amount: reseller.price,
            price_currency: reseller.currency,
            product_url: reseller.url,
            in_stock: true,
            fetched_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          }),
        }
      );
    } catch (error) {
      console.warn('[PriceDiscovery] Supabase reseller price upsert failed:', error);
    }
  }
}

// ============================================================================
// Main Workflow Function
// ============================================================================

export async function executePriceDiscoveryWorkflow(
  params: PriceDiscoveryParams
): Promise<PriceDiscoveryResult> {
  const runId = uuidv4();
  const startTime = Date.now();
  const db = getLibSQLClient();

  await db.execute({
    sql: `INSERT INTO workflow_runs (id, workflow_name, triggered_by, started_at, status)
          VALUES (?, 'price-discovery', 'api', ?, 'running')`,
    args: [runId, new Date().toISOString()],
  });

  try {
    console.info('[PriceDiscovery] Workflow started', { runId, gearItemId: params.gearItemId, name: params.name });

    const manufacturerPrice = params.productUrl
      ? await scrapeManufacturerPrice(params.productUrl, params.currency)
      : null;

    const resellers = await searchResellerPrices(params.brand, params.name, params.locale, params.currency, params.country);

    await writeToMemGraph(params.gearItemId, params.brand, params.name, manufacturerPrice, params.productUrl, resellers);

    await writeBackToSupabase(params.gearItemId, manufacturerPrice, resellers);

    const duration = Date.now() - startTime;

    await db.execute({
      sql: `UPDATE workflow_runs SET status = 'completed', completed_at = ?, result_summary = ? WHERE id = ?`,
      args: [new Date().toISOString(), JSON.stringify({ manufacturerPrice, resellerCount: resellers.length }), runId],
    });

    console.info('[PriceDiscovery] Workflow completed', { runId, gearItemId: params.gearItemId, manufacturerPrice, resellerCount: resellers.length, duration });

    return { runId, status: 'completed', manufacturerPrice, resellers, duration };
  } catch (error) {
    const duration = Date.now() - startTime;
    const errMsg = error instanceof Error ? error.message : String(error);

    await db.execute({
      sql: `UPDATE workflow_runs SET status = 'failed', completed_at = ?, error = ? WHERE id = ?`,
      args: [new Date().toISOString(), errMsg, runId],
    });

    console.error('[PriceDiscovery] Workflow failed', { runId, error: errMsg });

    return { runId, status: 'failed', manufacturerPrice: null, resellers: [], error: errMsg, duration };
  }
}

// ============================================================================
// Scheduler Integration
// ============================================================================

/**
 * Schedule the daily price refresh for stale items (>7 days since last discovery).
 * Call this from the app startup (same place as scheduleMorningHygiene).
 */
export function schedulePriceDiscoveryRefresh(): void {
  const scheduler = getScheduler();

  scheduler.schedule(
    'price-discovery-refresh',
    SCHEDULES.PRICE_DISCOVERY_REFRESH,
    async () => {
      const db = getMemgraphClient();
      console.info('[PriceDiscovery] Starting daily refresh run');

      try {
        const staleItems = await db.query<{ id: string; brand: string | null; name: string }>(
          `MATCH (g:GearItem)-[:HAS_PRICE]->(p:PricePoint)
           WHERE p.is_current = true
           WITH g, max(p.discovered_at) AS lastDiscovered
           WHERE lastDiscovered < localDateTime() - duration({days: 7})
           RETURN g.gearshack_id AS id, g.brand AS brand, g.name AS name
           LIMIT 100`
        );

        console.info(`[PriceDiscovery] Found ${staleItems.length} stale items to refresh`);

        for (let i = 0; i < staleItems.length; i++) {
          if (i > 0 && i % 10 === 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, 60_000));
          }
          const item = staleItems[i];
          void executePriceDiscoveryWorkflow({
            gearItemId: item.id,
            brand: item.brand,
            name: item.name,
            productUrl: null,
          }).catch((err: unknown) => {
            console.warn(`[PriceDiscovery] Refresh failed for ${item.id}:`, err);
          });
        }
      } catch (error) {
        console.error('[PriceDiscovery] Daily refresh failed:', error);
      }
    },
    { description: 'Daily price refresh for stale gear items (>7 days)' }
  );
}
