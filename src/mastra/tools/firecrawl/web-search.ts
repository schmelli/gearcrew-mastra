/**
 * T066: Firecrawl Web Scraping Tool
 * Implements FR-021: External data fetch for gear specifications
 */

import { z } from 'zod';
import { getCachedGearResult, setCachedGearResult } from './cache';

// Configuration schema
export const FirecrawlConfigSchema = z.object({
  apiKey: z.string(),
  baseUrl: z.string().default('https://api.firecrawl.dev/v1'),
  timeout: z.number().default(30000),
  maxRetries: z.number().default(3),
});

export type FirecrawlConfig = z.infer<typeof FirecrawlConfigSchema>;

// Request/Response schemas
const ScrapeRequestSchema = z.object({
  url: z.string().url(),
  formats: z.array(z.enum(['markdown', 'html', 'rawHtml', 'links', 'screenshot'])).optional(),
  onlyMainContent: z.boolean().optional().default(true),
  includeTags: z.array(z.string()).optional(),
  excludeTags: z.array(z.string()).optional(),
  waitFor: z.number().optional(),
});

const SearchRequestSchema = z.object({
  query: z.string(),
  limit: z.number().min(1).max(20).optional().default(5),
  scrapeOptions: z
    .object({
      formats: z.array(z.enum(['markdown', 'html', 'rawHtml', 'links'])).optional(),
    })
    .optional(),
});

export const GearSpecsSchema = z.object({
  name: z.string().optional(),
  brand: z.string().optional(),
  category: z.string().optional(),
  weight: z
    .object({
      value: z.number(),
      unit: z.enum(['g', 'kg', 'oz', 'lb']),
    })
    .optional(),
  price: z
    .object({
      value: z.number(),
      currency: z.string(),
    })
    .optional(),
  dimensions: z
    .object({
      length: z.number().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      unit: z.enum(['cm', 'in', 'mm']),
    })
    .optional(),
  capacity: z
    .object({
      value: z.number(),
      unit: z.enum(['L', 'ml', 'cu in']),
    })
    .optional(),
  temperatureRating: z
    .object({
      value: z.number(),
      unit: z.enum(['C', 'F']),
    })
    .optional(),
  materials: z.array(z.string()).optional(),
  features: z.array(z.string()).optional(),
  description: z.string().optional(),
  sourceUrl: z.string().optional(),
  imageUrl: z.string().optional(),
  scrapedAt: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),

  // Category-specific specs (T068 enhancement)
  /** Person capacity for tents/hammocks */
  capacityPersons: z.number().optional(),
  /** Season rating for tents/sleeping bags */
  seasonRating: z.enum(['3-season', '3.5-season', '4-season', 'summer', 'winter']).optional(),
  /** Frame type for backpacks */
  frameType: z.enum(['internal', 'external', 'frameless', 'removable']).optional(),
  /** Fuel type for stoves */
  fuelType: z
    .enum(['canister', 'alcohol', 'wood', 'solid', 'multi-fuel', 'white-gas', 'propane'])
    .optional(),
  /** Connector type for electronics */
  connectorType: z
    .enum(['usb-c', 'usb-a', 'micro-usb', 'usb-mini', 'lightning', 'proprietary'])
    .optional(),
  /** Construction type for tents */
  constructionType: z
    .enum([
      'freestanding',
      'semi-freestanding',
      'non-freestanding',
      'trekking-pole',
      'a-frame',
      'tunnel',
      'dome',
      'pyramid',
    ])
    .optional(),
  /** Size designation */
  size: z.string().optional(),
});

export type GearSpecs = z.infer<typeof GearSpecsSchema>;

// Retry configuration
interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
};

/**
 * Firecrawl client for web scraping
 */
export class FirecrawlClient {
  private config: FirecrawlConfig;
  private retryConfig: RetryConfig;

  constructor(config: Partial<FirecrawlConfig> = {}) {
    this.config = FirecrawlConfigSchema.parse({
      apiKey: config.apiKey || process.env.FIRECRAWL_API_KEY || '',
      ...config,
    });
    this.retryConfig = { ...DEFAULT_RETRY_CONFIG, maxRetries: this.config.maxRetries };
  }

  /**
   * Scrape a single URL for content
   */
  async scrape(
    url: string,
    options?: Partial<z.infer<typeof ScrapeRequestSchema>>
  ): Promise<ScrapeResult> {
    const request = ScrapeRequestSchema.parse({ url, ...options });

    return this.withRetry(async () => {
      const response = await fetch(`${this.config.baseUrl}/scrape`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(this.config.timeout),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new FirecrawlError(`Scrape failed: ${error}`, response.status);
      }

      const data = await response.json();
      return {
        success: true,
        data: {
          markdown: data.data?.markdown,
          html: data.data?.html,
          links: data.data?.links,
          metadata: data.data?.metadata,
        },
      };
    });
  }

  /**
   * Search the web and optionally scrape results
   */
  async search(
    query: string,
    options?: Partial<z.infer<typeof SearchRequestSchema>>
  ): Promise<SearchResult> {
    const request = SearchRequestSchema.parse({ query, ...options });

    return this.withRetry(async () => {
      const response = await fetch(`${this.config.baseUrl}/search`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(this.config.timeout),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new FirecrawlError(`Search failed: ${error}`, response.status);
      }

      const data = await response.json();
      return {
        success: true,
        results: data.data || [],
      };
    });
  }

  /**
   * Search for gear specifications and extract structured data
   * Uses cache to reduce API costs (TTL configurable via FIRECRAWL_CACHE_TTL_DAYS)
   */
  async searchGearSpecs(gearName: string, brand?: string): Promise<GearSearchResult> {
    // Check cache first
    const cached = await getCachedGearResult(gearName, brand);
    if (cached) {
      return {
        success: cached.specs !== null,
        specs: cached.specs,
        sources: cached.sources,
      };
    }

    const query = brand ? `${brand} ${gearName} specifications weight dimensions` : `${gearName} specifications weight dimensions outdoor gear`;

    const searchResult = await this.search(query, {
      limit: 5,
      scrapeOptions: { formats: ['markdown'] },
    });

    if (!searchResult.success || searchResult.results.length === 0) {
      // Cache negative result to avoid repeated lookups
      await setCachedGearResult(gearName, brand, null, []);
      return {
        success: false,
        error: 'No results found',
        specs: null,
      };
    }

    // Extract specs from each result
    const extractedSpecs: GearSpecs[] = [];

    for (const result of searchResult.results) {
      if (result.markdown) {
        const specs = this.extractGearSpecs(result.markdown, result.url, result.metadata);
        if (specs) {
          extractedSpecs.push(specs);
        }
      }
    }

    if (extractedSpecs.length === 0) {
      // Cache negative result
      const sources = searchResult.results.map((r) => r.url);
      await setCachedGearResult(gearName, brand, null, sources);
      return {
        success: false,
        error: 'Could not extract specifications from search results',
        specs: null,
      };
    }

    // Merge specs from multiple sources, preferring higher confidence
    const mergedSpecs = this.mergeGearSpecs(extractedSpecs);
    const sources = extractedSpecs.map((s) => s.sourceUrl).filter(Boolean) as string[];

    // Cache successful result
    await setCachedGearResult(gearName, brand, mergedSpecs, sources);

    return {
      success: true,
      specs: mergedSpecs,
      sources,
    };
  }

  /**
   * Extract image URL from metadata or HTML content
   */
  extractImageUrl(metadata?: Record<string, unknown>, html?: string): string | undefined {
    // Priority 1: og:image from metadata
    const ogImage = metadata?.ogImage ?? metadata?.['og:image'];
    if (typeof ogImage === 'string' && ogImage.startsWith('http')) {
      return ogImage;
    }

    // Priority 2: JSON-LD Product image from HTML
    if (html) {
      const jsonLdMatch = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
      if (jsonLdMatch) {
        try {
          const jsonLd = JSON.parse(jsonLdMatch[1]);
          const items = Array.isArray(jsonLd) ? jsonLd : [jsonLd];
          for (const item of items) {
            if (item['@type'] === 'Product' && typeof item.image === 'string' && item.image.startsWith('http')) {
              return item.image;
            }
            if (item['@type'] === 'Product' && Array.isArray(item.image) && item.image.length > 0) {
              const first = item.image[0];
              if (typeof first === 'string' && first.startsWith('http')) return first;
            }
          }
        } catch { /* invalid JSON-LD, skip */ }
      }
    }

    return undefined;
  }

  /**
   * Extract gear specifications from text content
   */
  extractGearSpecs(content: string, sourceUrl?: string, metadata?: Record<string, unknown>): GearSpecs | null {
    const specs: GearSpecs = {
      sourceUrl,
      scrapedAt: new Date().toISOString(),
      confidence: 0,
    };

    let fieldsFound = 0;

    // Extract image URL from metadata
    const imageUrl = this.extractImageUrl(metadata, content);
    if (imageUrl) {
      specs.imageUrl = imageUrl;
      fieldsFound++;
    }

    // Extract weight - handle markdown formatting and various patterns
    const weightPatterns = [
      // Standard format: "weight: 12.7 oz" or "Weight 288g"
      /(?:weight|wt\.?)[:\s]*(\d+(?:\.\d+)?)\s*(g|kg|oz|lbs?|ounces?|grams?|kilograms?)/i,
      // Format with newline/markdown: "Weight\n12.7 oz"
      /(?:weight|wt\.?)\s*[)\]\n\s]+(\d+(?:\.\d+)?)\s*(g|kg|oz|lbs?|ounces?|grams?|kilograms?)/i,
      // Standalone weight value: "12.7 oz" or "(288g)"
      /\((\d+(?:\.\d+)?)\s*(g|kg|oz|lbs?|ounces?|grams?|kilograms?)\)/i,
      // Weight with parentheses: "10.2 oz (288g)"
      /(\d+(?:\.\d+)?)\s*(oz|lbs?|ounces?)\s*\((\d+(?:\.\d+)?)\s*(g|grams?)\)/i,
    ];

    for (const pattern of weightPatterns) {
      const match = content.match(pattern);
      if (match) {
        // Handle pattern with oz (g) format
        if (match[3] && match[4]) {
          specs.weight = { value: parseFloat(match[3]), unit: normalizeWeightUnit(match[4]) };
        } else {
          specs.weight = { value: parseFloat(match[1]!), unit: normalizeWeightUnit(match[2]!) };
        }
        fieldsFound++;
        break;
      }
    }

    // Extract price
    const priceMatch = content.match(/(?:price|msrp|cost)[:\s]*\$?(\d+(?:\.\d{2})?)/i);
    if (priceMatch) {
      specs.price = { value: parseFloat(priceMatch[1]!), currency: 'USD' };
      fieldsFound++;
    }

    // Extract dimensions
    const dimMatch = content.match(
      /(?:dimensions?|size)[:\s]*(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(?:[x×]\s*(\d+(?:\.\d+)?))?\s*(cm|in|mm)?/i
    );
    if (dimMatch) {
      specs.dimensions = {
        length: parseFloat(dimMatch[1]!),
        width: parseFloat(dimMatch[2]!),
        height: dimMatch[3] ? parseFloat(dimMatch[3]) : undefined,
        unit: (dimMatch[4]?.toLowerCase() as 'cm' | 'in' | 'mm') || 'cm',
      };
      fieldsFound++;
    }

    // Extract capacity/volume
    const capacityMatch = content.match(
      /(?:capacity|volume)[:\s]*(\d+(?:\.\d+)?)\s*(L|liters?|ml|cu\.?\s*in)/i
    );
    if (capacityMatch) {
      const value = parseFloat(capacityMatch[1]!);
      const unit = normalizeVolumeUnit(capacityMatch[2]!);
      specs.capacity = { value, unit };
      fieldsFound++;
    }

    // Extract temperature rating
    const tempMatch = content.match(
      /(?:temperature|temp|rated?|comfort)[:\s]*(-?\d+)\s*°?\s*([FC])/i
    );
    if (tempMatch) {
      specs.temperatureRating = {
        value: parseInt(tempMatch[1]!, 10),
        unit: tempMatch[2]!.toUpperCase() as 'C' | 'F',
      };
      fieldsFound++;
    }

    // Extract materials (common outdoor gear materials)
    const materialKeywords = [
      'nylon',
      'polyester',
      'ripstop',
      'cordura',
      'dyneema',
      'cuben fiber',
      'silnylon',
      'dcf',
      'gore-tex',
      'pertex',
      'down',
      'synthetic',
      'aluminum',
      'titanium',
      'carbon fiber',
    ];
    const materials: string[] = [];
    for (const mat of materialKeywords) {
      if (content.toLowerCase().includes(mat)) {
        materials.push(mat);
      }
    }
    if (materials.length > 0) {
      specs.materials = materials;
      fieldsFound++;
    }

    // Extract brand
    const brandMatch = content.match(
      /(?:brand|manufacturer|made by)[:\s]*([A-Z][a-zA-Z\s]+?)(?:\s*[-–|]|\s*$)/
    );
    if (brandMatch) {
      specs.brand = brandMatch[1]!.trim();
      fieldsFound++;
    }

    // Extract person capacity (tents, hammocks)
    const personsMatch = content.match(
      /(\d+)\s*[-–]?\s*(?:person|man|p|personen|plätze|sleeps)/i
    );
    if (personsMatch) {
      specs.capacityPersons = parseInt(personsMatch[1]!, 10);
      fieldsFound++;
    }

    // Extract season rating
    const seasonMatch = content.match(
      /(?:season|jahreszeit)[:\s]*(3\.?5|3|4|summer|winter)[-\s]?season/i
    );
    if (seasonMatch) {
      const rating = seasonMatch[1]!.toLowerCase();
      if (rating === '3' || rating === '3.5' || rating === '4') {
        specs.seasonRating = `${rating}-season` as typeof specs.seasonRating;
      } else {
        specs.seasonRating = rating as typeof specs.seasonRating;
      }
      fieldsFound++;
    }

    // Extract frame type (backpacks)
    const contentLower = content.toLowerCase();
    if (contentLower.includes('internal frame')) {
      specs.frameType = 'internal';
      fieldsFound++;
    } else if (contentLower.includes('external frame')) {
      specs.frameType = 'external';
      fieldsFound++;
    } else if (contentLower.includes('frameless')) {
      specs.frameType = 'frameless';
      fieldsFound++;
    } else if (contentLower.includes('removable frame')) {
      specs.frameType = 'removable';
      fieldsFound++;
    }

    // Extract fuel type (stoves)
    const fuelTypes: Array<{ pattern: RegExp; value: typeof specs.fuelType }> = [
      { pattern: /canister\s*(?:stove|fuel|gas)/i, value: 'canister' },
      { pattern: /alcohol\s*(?:stove|burner|fuel)/i, value: 'alcohol' },
      { pattern: /wood\s*(?:burning|stove)/i, value: 'wood' },
      { pattern: /esbit|solid\s*fuel/i, value: 'solid' },
      { pattern: /multi[-\s]?fuel/i, value: 'multi-fuel' },
      { pattern: /white\s*gas/i, value: 'white-gas' },
      { pattern: /propane/i, value: 'propane' },
    ];
    for (const { pattern, value } of fuelTypes) {
      if (pattern.test(content)) {
        specs.fuelType = value;
        fieldsFound++;
        break;
      }
    }

    // Extract connector type (electronics)
    if (/usb[-\s]?c|type[-\s]?c/i.test(content)) {
      specs.connectorType = 'usb-c';
      fieldsFound++;
    } else if (/usb[-\s]?a/i.test(content)) {
      specs.connectorType = 'usb-a';
      fieldsFound++;
    } else if (/micro[-\s]?usb/i.test(content)) {
      specs.connectorType = 'micro-usb';
      fieldsFound++;
    } else if (/mini[-\s]?usb/i.test(content)) {
      specs.connectorType = 'usb-mini';
      fieldsFound++;
    } else if (/lightning/i.test(content)) {
      specs.connectorType = 'lightning';
      fieldsFound++;
    }

    // Extract construction type (tents)
    const constructionTypes: Array<{ pattern: RegExp; value: typeof specs.constructionType }> = [
      { pattern: /semi[-\s]?freestanding/i, value: 'semi-freestanding' },
      { pattern: /non[-\s]?freestanding/i, value: 'non-freestanding' },
      { pattern: /\bfreestanding\b/i, value: 'freestanding' },
      { pattern: /trekking[-\s]?pole/i, value: 'trekking-pole' },
      { pattern: /\ba[-\s]?frame\b/i, value: 'a-frame' },
      { pattern: /\btunnel\b/i, value: 'tunnel' },
      { pattern: /\bdome\b/i, value: 'dome' },
      { pattern: /\bpyramid\b|\bmid\b/i, value: 'pyramid' },
    ];
    for (const { pattern, value } of constructionTypes) {
      if (pattern.test(content)) {
        specs.constructionType = value;
        fieldsFound++;
        break;
      }
    }

    // Extract size
    const sizeMatch = content.match(
      /(?:size|größe)[:\s]*((?:X?S|S|M|L|X{1,3}L|regular|long|wide|short))/i
    );
    if (sizeMatch) {
      specs.size = sizeMatch[1]!.toUpperCase();
      fieldsFound++;
    }

    // Calculate confidence based on fields found (now 15 possible fields)
    specs.confidence = Math.min(fieldsFound / 15, 1);

    return fieldsFound > 0 ? specs : null;
  }

  /**
   * Merge gear specs from multiple sources
   */
  mergeGearSpecs(specsList: GearSpecs[]): GearSpecs {
    const merged: GearSpecs = {
      scrapedAt: new Date().toISOString(),
      confidence: 0,
    };

    // Sort by confidence descending
    const sorted = [...specsList].sort((a, b) => (b.confidence || 0) - (a.confidence || 0));

    // Take the highest confidence value for each field
    for (const specs of sorted) {
      if (specs.name && !merged.name) merged.name = specs.name;
      if (specs.brand && !merged.brand) merged.brand = specs.brand;
      if (specs.category && !merged.category) merged.category = specs.category;
      if (specs.weight && !merged.weight) merged.weight = specs.weight;
      if (specs.price && !merged.price) merged.price = specs.price;
      if (specs.dimensions && !merged.dimensions) merged.dimensions = specs.dimensions;
      if (specs.capacity && !merged.capacity) merged.capacity = specs.capacity;
      if (specs.temperatureRating && !merged.temperatureRating) {
        merged.temperatureRating = specs.temperatureRating;
      }
      if (specs.description && !merged.description) merged.description = specs.description;

      // Category-specific specs
      if (specs.capacityPersons && !merged.capacityPersons) merged.capacityPersons = specs.capacityPersons;
      if (specs.seasonRating && !merged.seasonRating) merged.seasonRating = specs.seasonRating;
      if (specs.frameType && !merged.frameType) merged.frameType = specs.frameType;
      if (specs.fuelType && !merged.fuelType) merged.fuelType = specs.fuelType;
      if (specs.connectorType && !merged.connectorType) merged.connectorType = specs.connectorType;
      if (specs.constructionType && !merged.constructionType) merged.constructionType = specs.constructionType;
      if (specs.size && !merged.size) merged.size = specs.size;
      if (specs.imageUrl && !merged.imageUrl) merged.imageUrl = specs.imageUrl;

      // Merge materials
      if (specs.materials) {
        merged.materials = [...new Set([...(merged.materials || []), ...specs.materials])];
      }

      // Merge features
      if (specs.features) {
        merged.features = [...new Set([...(merged.features || []), ...specs.features])];
      }
    }

    // Calculate overall confidence (15 possible fields now)
    let fieldsPopulated = 0;
    if (merged.weight) fieldsPopulated++;
    if (merged.price) fieldsPopulated++;
    if (merged.dimensions) fieldsPopulated++;
    if (merged.capacity) fieldsPopulated++;
    if (merged.temperatureRating) fieldsPopulated++;
    if (merged.materials?.length) fieldsPopulated++;
    if (merged.brand) fieldsPopulated++;
    if (merged.capacityPersons) fieldsPopulated++;
    if (merged.seasonRating) fieldsPopulated++;
    if (merged.frameType) fieldsPopulated++;
    if (merged.fuelType) fieldsPopulated++;
    if (merged.connectorType) fieldsPopulated++;
    if (merged.constructionType) fieldsPopulated++;
    if (merged.size) fieldsPopulated++;
    if (merged.imageUrl) fieldsPopulated++;

    merged.confidence = fieldsPopulated / 15;

    return merged;
  }

  /**
   * Execute with retry and exponential backoff
   */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: Error = new Error('No attempts made');

    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error as Error;

        // Don't retry on client errors (except rate limits)
        if (error instanceof FirecrawlError) {
          if (error.statusCode >= 400 && error.statusCode < 500 && error.statusCode !== 429) {
            throw error;
          }
        }

        // Don't delay after the last attempt
        if (attempt === this.retryConfig.maxRetries) {
          break;
        }

        // Calculate delay with exponential backoff
        const delay = Math.min(
          this.retryConfig.baseDelayMs * Math.pow(this.retryConfig.backoffMultiplier, attempt),
          this.retryConfig.maxDelayMs
        );

        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }
}

// Helper types
interface ScrapeResult {
  success: boolean;
  data: {
    markdown?: string;
    html?: string;
    links?: string[];
    metadata?: Record<string, unknown>;
  };
}

interface SearchResult {
  success: boolean;
  results: Array<{
    url: string;
    title?: string;
    markdown?: string;
    description?: string;
    metadata?: Record<string, unknown>;
  }>;
}

interface GearSearchResult {
  success: boolean;
  specs: GearSpecs | null;
  sources?: string[];
  error?: string;
}

class FirecrawlError extends Error {
  constructor(
    message: string,
    public statusCode: number
  ) {
    super(message);
    this.name = 'FirecrawlError';
  }
}

// Unit normalization helpers
function normalizeWeightUnit(unit: string): 'g' | 'kg' | 'oz' | 'lb' {
  const normalized = unit.toLowerCase();
  if (normalized.includes('kg') || normalized.includes('kilogram')) return 'kg';
  if (normalized.includes('oz') || normalized.includes('ounce')) return 'oz';
  if (normalized.includes('lb') || normalized.includes('pound')) return 'lb';
  return 'g';
}

function normalizeVolumeUnit(unit: string): 'L' | 'ml' | 'cu in' {
  const normalized = unit.toLowerCase();
  if (normalized.includes('ml')) return 'ml';
  if (normalized.includes('cu') || normalized.includes('cubic')) return 'cu in';
  return 'L';
}

/**
 * Create a Mastra-compatible tool for gear spec search
 */
export function createGearSpecSearchTool() {
  return {
    name: 'searchGearSpecs',
    description: 'Search the web for gear specifications and extract structured data',
    inputSchema: z.object({
      gearName: z.string().describe('Name of the gear item to search for'),
      brand: z.string().optional().describe('Optional brand name for more accurate results'),
    }),
    execute: async (input: { gearName: string; brand?: string }) => {
      const client = new FirecrawlClient();
      return client.searchGearSpecs(input.gearName, input.brand);
    },
  };
}

/**
 * Create a Mastra-compatible tool for web scraping
 */
export function createWebScrapeTool() {
  return {
    name: 'scrapeUrl',
    description: 'Scrape a URL and extract content as markdown',
    inputSchema: z.object({
      url: z.string().url().describe('URL to scrape'),
      onlyMainContent: z.boolean().optional().describe('Extract only main content (default: true)'),
    }),
    execute: async (input: { url: string; onlyMainContent?: boolean }) => {
      const client = new FirecrawlClient();
      return client.scrape(input.url, { onlyMainContent: input.onlyMainContent });
    },
  };
}
