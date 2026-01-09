/**
 * Researcher Agent
 * Phase 1 of Consolidated Agent Architecture
 *
 * Responsibilities:
 * - Web search via Firecrawl
 * - Comprehensive product research (not just basic specs)
 * - Returns JSON findings only - NO graph writes
 * - Rate limiting (20 req/min)
 */

import { z } from 'zod';
import { FirecrawlClient } from '../tools/firecrawl/web-search';
import { createOpenAI } from '@ai-sdk/openai';

// DeepSeek provider (OpenAI-compatible API)
const deepseek = createOpenAI({
  name: 'deepseek',
  baseURL: 'https://api.deepseek.com',
  apiKey: process.env.DEEPSEEK_API_KEY ?? '',
  compatibility: 'compatible', // Use compatible mode for non-OpenAI providers
});
import { generateObject } from 'ai';

// ============================================================================
// Configuration
// ============================================================================

const RESEARCHER_CONFIG = {
  rateLimit: {
    requestsPerMinute: 20,
    delayMs: 3000,
  },
  maxSearchResults: 5,
  confidenceThreshold: 0.5,
};

// ============================================================================
// Request Schema
// ============================================================================

export const ResearchRequestSchema = z.object({
  nodeId: z.string(),
  nodeName: z.string(),
  brand: z.string().optional(),
  category: z.string().optional(),
  missingFields: z.array(z.string()),
  priority: z.number().min(0).max(1).default(0.5),
});

export type ResearchRequest = z.infer<typeof ResearchRequestSchema>;

// ============================================================================
// Comprehensive Research Findings Schema
// ============================================================================

export const ResearchFindingsSchema = z.object({
  nodeId: z.string(),
  success: z.boolean(),

  // Basic specs
  specs: z.object({
    weight: z.object({
      value: z.number(),
      unit: z.string(),
      confidence: z.number(),
    }).optional(),
    price: z.object({
      value: z.number(),
      currency: z.string(),
      confidence: z.number(),
    }).optional(),
    dimensions: z.object({
      length: z.number(),
      width: z.number(),
      height: z.number().optional(),
      unit: z.string(),
      confidence: z.number(),
    }).optional(),
    materials: z.array(z.object({
      name: z.string(),
      percentage: z.number().optional(),
      recycled: z.boolean().optional(),
    })).optional(),
    colors: z.array(z.string()).optional(),
    sizes: z.array(z.string()).optional(),
  }).optional(),

  // Brand & Product Family
  brand: z.object({
    name: z.string(),
    verified: z.boolean(),
    websiteUrl: z.string().optional(),
    confidence: z.number(),
  }).optional(),

  productFamily: z.object({
    name: z.string(),
    positioning: z.string(),
    pricePoint: z.enum(['budget', 'mid-range', 'premium']),
    variants: z.array(z.object({
      name: z.string(),
      sku: z.string().optional(),
      targetGender: z.enum(['mens', 'womens', 'unisex']).optional(),
      specificWeight: z.number().optional(),
      distinguishingFeatures: z.array(z.string()).optional(),
    })),
  }).optional(),

  // Technology & Construction
  technologies: z.array(z.object({
    name: z.string(),
    description: z.string(),
    performanceRatings: z.record(z.union([z.string(), z.number()])).optional(),
  })).optional(),

  construction: z.object({
    layers: z.number().optional(),
    fabricDenier: z.number().optional(),
    features: z.array(z.string()).optional(),
  }).optional(),

  // Usage & Recommendations
  usageScenarios: z.array(z.object({
    activity: z.string(),
    suitability: z.enum(['ideal', 'good', 'acceptable', 'not-recommended']),
    notes: z.string().optional(),
    priority: z.number().optional(),
  })),

  // User Feedback Patterns
  feedbackPatterns: z.object({
    commonPraise: z.array(z.string()),
    commonComplaints: z.array(z.string()),
    overallSentiment: z.enum(['very-positive', 'positive', 'mixed', 'negative']).optional(),
  }).optional(),

  // Insights & Tips
  insights: z.array(z.object({
    type: z.enum(['tip', 'warning', 'comparison', 'maintenance']),
    content: z.string(),
    sourceUrl: z.string().optional(),
  })).optional(),

  // Performance Context
  performanceMetrics: z.object({
    durabilityRating: z.number().min(1).max(10).optional(),
    comfortRating: z.number().min(1).max(10).optional(),
    weatherResistance: z.number().min(1).max(10).optional(),
    easeOfUseRating: z.number().min(1).max(10).optional(),
    packEfficiency: z.string().optional(),
    maintenanceRequirements: z.string().optional(),
    durabilityNote: z.string().optional(),
    comfortNote: z.string().optional(),
    weatherResistanceNote: z.string().optional(),
    easeOfUseNote: z.string().optional(),
    packEfficiencyNote: z.string().optional(),
  }).optional(),

  // Temperature Range
  temperatureRange: z.object({
    minTemp: z.number(),
    maxTemp: z.number(),
    unit: z.enum(['C', 'F']),
    optimalRange: z.string().optional(),
    reasoning: z.string().optional(),
  }).optional(),

  // Weather Performance
  weatherPerformance: z.array(z.object({
    condition: z.string(),
    suitability: z.string(),
    notes: z.string().optional(),
  })).optional(),

  // Product Type Classification
  productType: z.string().optional(),

  // Comparisons with other products
  comparisons: z.array(z.object({
    targetName: z.string(),
    type: z.enum(['COMPARE_TO', 'ALTERNATIVE_TO', 'PAIRS_WITH', 'UPGRADE_PATH']),
    difference: z.string().optional(),
    useCase: z.string().optional(),
    tradeoff: z.string().optional(),
    reason: z.string().optional(),
  })).optional(),

  // Sustainability
  sustainability: z.object({
    materials: z.array(z.object({
      source: z.string(),
      description: z.string(),
    })).optional(),
    certifications: z.array(z.string()).optional(),
    pfasFree: z.boolean().optional(),
  }).optional(),

  // Sources
  sources: z.array(z.object({
    url: z.string(),
    title: z.string(),
    trustScore: z.number(),
    dataTypes: z.array(z.string()),
  })),

  overallConfidence: z.number(),
  researchedAt: z.string(),
  error: z.string().optional(),
});

export type ResearchFindings = z.infer<typeof ResearchFindingsSchema>;

// ============================================================================
// Researcher Agent Class
// ============================================================================

export class ResearcherAgent {
  private firecrawl: FirecrawlClient;
  private rateLimitQueue: number[] = [];

  constructor() {
    this.firecrawl = new FirecrawlClient();
  }

  /**
   * Research a single gear item comprehensively
   */
  async researchItem(request: ResearchRequest): Promise<ResearchFindings> {
    const { nodeId, nodeName, brand, category } = request;

    await this.waitForRateLimit();

    try {
      // Build comprehensive search queries
      const queries = this.buildSearchQueries(nodeName, brand, category);

      // Collect content from multiple searches
      const allContent: Array<{ url: string; title: string; content: string }> = [];

      for (const query of queries) {
        try {
          const searchResult = await this.firecrawl.search(query, {
            searchOptions: { limit: RESEARCHER_CONFIG.maxSearchResults },
            pageOptions: { fetchPageContent: true, onlyMainContent: true },
          });

          if (searchResult.success && searchResult.results) {
            for (const result of searchResult.results) {
              if (result.content && result.content.length > 100) {
                allContent.push({
                  url: result.url,
                  title: result.title,
                  content: result.content.substring(0, 8000), // Limit content size
                });
              }
            }
          }
        } catch (err) {
          console.warn(`Search query failed: ${query}`, err);
        }

        // Rate limit between searches
        await new Promise(r => setTimeout(r, 1000));
      }

      if (allContent.length === 0) {
        return this.createEmptyFindings(nodeId, 'No search results found');
      }

      // Use LLM to extract comprehensive structured data
      const findings = await this.extractComprehensiveData(
        nodeId,
        nodeName,
        brand,
        category,
        allContent
      );

      return findings;
    } catch (error) {
      return this.createEmptyFindings(
        nodeId,
        error instanceof Error ? error.message : 'Unknown error'
      );
    }
  }

  /**
   * Research a product family to discover all variants
   */
  async researchProductFamily(
    brandName: string,
    familyName: string
  ): Promise<ResearchFindings[]> {
    await this.waitForRateLimit();

    const query = `${brandName} ${familyName} product line variants specifications`;

    try {
      const searchResult = await this.firecrawl.search(query, {
        searchOptions: { limit: 10 },
        pageOptions: { fetchPageContent: true, onlyMainContent: true },
      });

      if (!searchResult.success || searchResult.results.length === 0) {
        return [];
      }

      // Collect all content
      const allContent: Array<{ url: string; title: string; content: string }> = [];
      for (const result of searchResult.results) {
        if (result.content && result.content.length > 100) {
          allContent.push({
            url: result.url,
            title: result.title,
            content: result.content.substring(0, 8000),
          });
        }
      }

      // Extract family information
      const findings = await this.extractProductFamilyData(
        brandName,
        familyName,
        allContent
      );

      return findings;
    } catch (error) {
      console.error('Product family research failed:', error);
      return [];
    }
  }

  /**
   * Verify a brand exists and get basic info
   */
  async verifyBrand(brandName: string): Promise<{
    verified: boolean;
    websiteUrl?: string;
    founded?: number;
    headquarters?: string;
    specialties?: string[];
  }> {
    await this.waitForRateLimit();

    const query = `${brandName} outdoor gear brand official website`;

    try {
      const searchResult = await this.firecrawl.search(query, {
        searchOptions: { limit: 3 },
        pageOptions: { fetchPageContent: true, onlyMainContent: true },
      });

      if (!searchResult.success || searchResult.results.length === 0) {
        return { verified: false };
      }

      // Check if any result looks like an official brand page
      for (const result of searchResult.results) {
        const lowerUrl = result.url.toLowerCase();
        const lowerTitle = result.title.toLowerCase();
        const brandLower = brandName.toLowerCase().replace(/\s+/g, '');

        if (
          lowerUrl.includes(brandLower) ||
          lowerTitle.includes(brandName.toLowerCase())
        ) {
          return {
            verified: true,
            websiteUrl: result.url,
          };
        }
      }

      return { verified: false };
    } catch {
      return { verified: false };
    }
  }

  /**
   * Build multiple search queries for comprehensive coverage
   */
  private buildSearchQueries(
    productName: string,
    brand?: string,
    category?: string
  ): string[] {
    const baseName = brand ? `${brand} ${productName}` : productName;
    const queries: string[] = [];

    // Main product specifications
    queries.push(`${baseName} specifications weight dimensions review`);

    // Reviews and user feedback
    queries.push(`${baseName} review pros cons outdoor`);

    // Technical details
    if (category) {
      queries.push(`${baseName} ${category} technical features`);
    }

    // Comparisons and alternatives
    queries.push(`${baseName} vs comparison alternative`);

    return queries;
  }

  /**
   * Use LLM to extract comprehensive structured data from content
   */
  private async extractComprehensiveData(
    nodeId: string,
    productName: string,
    brand: string | undefined,
    category: string | undefined,
    content: Array<{ url: string; title: string; content: string }>
  ): Promise<ResearchFindings> {
    const combinedContent = content
      .map(c => `Source: ${c.title} (${c.url})\n${c.content}`)
      .join('\n\n---\n\n');

    const prompt = `You are a researcher analyzing outdoor gear products. Extract comprehensive information about "${productName}"${brand ? ` by ${brand}` : ''}${category ? ` (${category})` : ''}.

From the following web content, extract ALL available information about this product. Be thorough - we want everything: specifications, technologies used, user feedback patterns, usage scenarios, maintenance tips, comparisons with other products, etc.

Content to analyze:
${combinedContent}

Extract structured data following these guidelines:
1. specs: Extract weight (in grams if possible), price (USD), dimensions (cm), materials used
2. brand: Verify brand name and look for official website URL
3. productFamily: If this is part of a product line (e.g., "Torrentshell 3L"), identify it
4. technologies: List any proprietary technologies (e.g., Gore-Tex, H2No, Polartec)
5. usageScenarios: What activities is this product good/bad for?
6. feedbackPatterns: Common praise and complaints from users
7. insights: Maintenance tips, usage tips, warnings, comparisons
8. performanceMetrics: Ratings for durability, comfort, weather resistance (1-10)
9. temperatureRange: If applicable (sleeping bags, insulation)
10. weatherPerformance: How does it perform in rain, wind, snow, etc.?
11. comparisons: Other products it's compared to or alternatives
12. sustainability: Recycled materials, certifications, PFAS-free status

Be conservative with confidence - only include data you're confident about.`;

    try {
      const result = await generateObject({
        model: deepseek('deepseek-reasoner'),
        schema: ResearchFindingsSchema.omit({ nodeId: true, researchedAt: true }),
        prompt,
      });

      const findings: ResearchFindings = {
        nodeId,
        ...result.object,
        researchedAt: new Date().toISOString(),
        sources: content.map(c => ({
          url: c.url,
          title: c.title,
          trustScore: this.calculateTrustScore(c.url),
          dataTypes: this.identifyDataTypes(c.content),
        })),
      };

      return findings;
    } catch (error) {
      console.error('LLM extraction failed:', error);
      return this.createEmptyFindings(
        nodeId,
        error instanceof Error ? error.message : 'LLM extraction failed'
      );
    }
  }

  /**
   * Extract product family data for multiple variants
   */
  private async extractProductFamilyData(
    brandName: string,
    familyName: string,
    content: Array<{ url: string; title: string; content: string }>
  ): Promise<ResearchFindings[]> {
    const combinedContent = content
      .map(c => `Source: ${c.title} (${c.url})\n${c.content}`)
      .join('\n\n---\n\n');

    const prompt = `You are a researcher analyzing the ${brandName} ${familyName} product line.

From the following web content, identify ALL variants/models in this product family and extract comprehensive information about each.

Content to analyze:
${combinedContent}

For each variant found, extract:
- Name and SKU
- Specific weight, price, dimensions
- Target gender (mens/womens/unisex)
- Distinguishing features from other variants
- Any variant-specific reviews or feedback

Return an array where each item represents one product variant.`;

    try {
      const result = await generateObject({
        model: deepseek('deepseek-reasoner'),
        schema: z.object({
          variants: z.array(ResearchFindingsSchema.omit({ nodeId: true, researchedAt: true })),
        }),
        prompt,
      });

      return result.object.variants.map((v, i) => ({
        nodeId: `${brandName}-${familyName}-variant-${i}`,
        ...v,
        researchedAt: new Date().toISOString(),
        sources: content.map(c => ({
          url: c.url,
          title: c.title,
          trustScore: this.calculateTrustScore(c.url),
          dataTypes: this.identifyDataTypes(c.content),
        })),
      }));
    } catch (error) {
      console.error('Product family extraction failed:', error);
      return [];
    }
  }

  /**
   * Calculate trust score based on URL domain
   */
  private calculateTrustScore(url: string): number {
    const trustedDomains = [
      'rei.com',
      'backcountry.com',
      'outdoorgearlab.com',
      'switchbacktravel.com',
      'cleverhiker.com',
      'sectionhiker.com',
      'patagonia.com',
      'arcteryx.com',
      'osprey.com',
      'thermarest.com',
    ];

    const domain = new URL(url).hostname.toLowerCase();

    for (const trusted of trustedDomains) {
      if (domain.includes(trusted)) {
        return 0.9;
      }
    }

    // Official brand sites
    if (domain.includes('.com') && !domain.includes('amazon') && !domain.includes('ebay')) {
      return 0.7;
    }

    return 0.5;
  }

  /**
   * Identify what types of data are in the content
   */
  private identifyDataTypes(content: string): string[] {
    const types: string[] = [];
    const lowerContent = content.toLowerCase();

    if (/\d+\s*(g|grams?|oz|ounces?|kg|lbs?)/i.test(content)) {
      types.push('weight');
    }
    if (/\$\d+|\d+\s*(usd|eur|gbp)/i.test(content)) {
      types.push('price');
    }
    if (/review|rating|stars?|pros|cons/i.test(lowerContent)) {
      types.push('review');
    }
    if (/specifications?|specs?|dimensions?/i.test(lowerContent)) {
      types.push('specifications');
    }
    if (/gore-tex|pertex|polartec|dyneema|h2no/i.test(lowerContent)) {
      types.push('technology');
    }
    if (/waterproof|breathab|durable|comfort/i.test(lowerContent)) {
      types.push('performance');
    }

    return types.length > 0 ? types : ['general'];
  }

  /**
   * Create empty findings for error cases
   */
  private createEmptyFindings(nodeId: string, error: string): ResearchFindings {
    return {
      nodeId,
      success: false,
      usageScenarios: [],
      sources: [],
      overallConfidence: 0,
      researchedAt: new Date().toISOString(),
      error,
    };
  }

  /**
   * Wait for rate limit
   */
  private async waitForRateLimit(): Promise<void> {
    const now = Date.now();
    const windowMs = 60000;

    this.rateLimitQueue = this.rateLimitQueue.filter(t => now - t < windowMs);

    if (this.rateLimitQueue.length >= RESEARCHER_CONFIG.rateLimit.requestsPerMinute) {
      const oldestRequest = this.rateLimitQueue[0]!;
      const waitTime = windowMs - (now - oldestRequest);
      if (waitTime > 0) {
        await new Promise(r => setTimeout(r, waitTime));
      }
    }

    this.rateLimitQueue.push(Date.now());
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let researcherInstance: ResearcherAgent | null = null;

export function getResearcherAgent(): ResearcherAgent {
  if (!researcherInstance) {
    researcherInstance = new ResearcherAgent();
  }
  return researcherInstance;
}
