/**
 * T066: Firecrawl Web Scraping Tool
 * Implements FR-021: External data fetch for gear specifications
 */

import { z } from 'zod';

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
  pageOptions: z
    .object({
      onlyMainContent: z.boolean().optional(),
      fetchPageContent: z.boolean().optional(),
    })
    .optional(),
  searchOptions: z
    .object({
      limit: z.number().min(1).max(20).optional().default(5),
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
  scrapedAt: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
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
   */
  async searchGearSpecs(gearName: string, brand?: string): Promise<GearSearchResult> {
    const query = brand ? `${brand} ${gearName} specifications weight dimensions` : `${gearName} specifications weight dimensions outdoor gear`;

    const searchResult = await this.search(query, {
      searchOptions: { limit: 5 },
      pageOptions: { fetchPageContent: true, onlyMainContent: true },
    });

    if (!searchResult.success || searchResult.results.length === 0) {
      return {
        success: false,
        error: 'No results found',
        specs: null,
      };
    }

    // Extract specs from each result
    const extractedSpecs: GearSpecs[] = [];

    for (const result of searchResult.results) {
      if (result.content) {
        const specs = this.extractGearSpecs(result.content, result.url);
        if (specs) {
          extractedSpecs.push(specs);
        }
      }
    }

    if (extractedSpecs.length === 0) {
      return {
        success: false,
        error: 'Could not extract specifications from search results',
        specs: null,
      };
    }

    // Merge specs from multiple sources, preferring higher confidence
    const mergedSpecs = this.mergeGearSpecs(extractedSpecs);

    return {
      success: true,
      specs: mergedSpecs,
      sources: extractedSpecs.map((s) => s.sourceUrl).filter(Boolean) as string[],
    };
  }

  /**
   * Extract gear specifications from text content
   */
  extractGearSpecs(content: string, sourceUrl?: string): GearSpecs | null {
    const specs: GearSpecs = {
      sourceUrl,
      scrapedAt: new Date().toISOString(),
      confidence: 0,
    };

    let fieldsFound = 0;

    // Extract weight
    const weightMatch = content.match(
      /(?:weight|wt\.?)[:\s]*(\d+(?:\.\d+)?)\s*(g|kg|oz|lbs?|ounces?|grams?|kilograms?)/i
    );
    if (weightMatch) {
      const value = parseFloat(weightMatch[1]!);
      const unit = normalizeWeightUnit(weightMatch[2]!);
      specs.weight = { value, unit };
      fieldsFound++;
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

    // Calculate confidence based on fields found
    specs.confidence = Math.min(fieldsFound / 7, 1);

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

      // Merge materials
      if (specs.materials) {
        merged.materials = [...new Set([...(merged.materials || []), ...specs.materials])];
      }

      // Merge features
      if (specs.features) {
        merged.features = [...new Set([...(merged.features || []), ...specs.features])];
      }
    }

    // Calculate overall confidence
    let fieldsPopulated = 0;
    if (merged.weight) fieldsPopulated++;
    if (merged.price) fieldsPopulated++;
    if (merged.dimensions) fieldsPopulated++;
    if (merged.capacity) fieldsPopulated++;
    if (merged.temperatureRating) fieldsPopulated++;
    if (merged.materials?.length) fieldsPopulated++;
    if (merged.brand) fieldsPopulated++;

    merged.confidence = fieldsPopulated / 7;

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
    title: string;
    content?: string;
    description?: string;
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
