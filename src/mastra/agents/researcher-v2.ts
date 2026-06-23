/**
 * Researcher Agent v2
 *
 * Mastra-native implementation of the Researcher agent.
 * Uses Mastra Agent class with web research tools (Firecrawl integration).
 *
 * Responsibilities:
 * - Web search via Firecrawl
 * - Comprehensive product research
 * - Returns JSON findings only - NO graph writes
 * - Rate limiting (20 req/min)
 */

import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { z } from 'zod';
import { registerAgent } from '../index';
import { FirecrawlClient } from '../tools/firecrawl/web-search';
// Note: Memory integration pending @mastra/memory package version alignment
// import { getResearchMemory } from '../memory/mastra-memory';

// ============================================================================
// Research Tools
// ============================================================================

const searchWebTool = createTool({
  id: 'search-web',
  description: 'Search the web for product information using Firecrawl',
  inputSchema: z.object({
    query: z.string().describe('Search query for the product'),
    limit: z.number().default(5).describe('Maximum number of results'),
  }),
  outputSchema: z.object({
    results: z.array(z.object({
      url: z.string(),
      title: z.string(),
      content: z.string(),
      trustScore: z.number(),
    })),
    totalResults: z.number(),
  }),
  execute: async ({ context }) => {
    const { query, limit } = context;
    const firecrawl = new FirecrawlClient();
    const searchResult = await firecrawl.search(query, { limit });

    if (!searchResult.success || !searchResult.results) {
      return { results: [], totalResults: 0 };
    }

    return {
      results: searchResult.results.map((r: { url: string; title?: string; markdown?: string }) => ({
        url: r.url,
        title: r.title ?? 'Untitled',
        content: r.markdown?.substring(0, 2000) ?? '',
        trustScore: getTrustScore(r.url),
      })),
      totalResults: searchResult.results.length,
    };
  },
});

const scrapeUrlTool = createTool({
  id: 'scrape-url',
  description: 'Scrape detailed content from a specific URL',
  inputSchema: z.object({
    url: z.string().url().describe('URL to scrape'),
  }),
  outputSchema: z.object({
    url: z.string(),
    title: z.string(),
    content: z.string(),
    success: z.boolean(),
    error: z.string().optional(),
  }),
  execute: async ({ context }) => {
    const { url } = context;
    const firecrawl = new FirecrawlClient();

    try {
      const result = await firecrawl.scrape(url);
      return {
        url,
        title: String(result.data?.metadata?.title ?? 'Untitled'),
        content: result.data?.markdown?.substring(0, 5000) ?? '',
        success: result.success,
      };
    } catch (error) {
      return {
        url,
        title: '',
        content: '',
        success: false,
        error: error instanceof Error ? error.message : 'Failed to scrape URL',
      };
    }
  },
});

const verifyBrandTool = createTool({
  id: 'verify-brand',
  description: 'Verify if a brand exists and get its official website',
  inputSchema: z.object({
    brandName: z.string().describe('Brand name to verify'),
    productCategory: z.string().optional().describe('Product category for context'),
  }),
  outputSchema: z.object({
    exists: z.boolean(),
    officialName: z.string().optional(),
    websiteUrl: z.string().optional(),
    confidence: z.number(),
    alternativeNames: z.array(z.string()).optional(),
  }),
  execute: async ({ context }) => {
    const { brandName, productCategory } = context;
    const firecrawl = new FirecrawlClient();
    const query = productCategory
      ? `${brandName} ${productCategory} official website`
      : `${brandName} outdoor gear official website`;

    const searchResult = await firecrawl.search(query, { limit: 3 });

    if (!searchResult.success || !searchResult.results) {
      return {
        exists: false,
        confidence: 0.2,
        alternativeNames: [],
      };
    }

    // Look for official brand domain
    const brandDomainPattern = brandName.toLowerCase().replace(/\s+/g, '');
    const officialSite = searchResult.results.find((r: { url: string }) =>
      r.url.toLowerCase().includes(brandDomainPattern)
    );

    return {
      exists: searchResult.results.length > 0,
      officialName: officialSite ? brandName : undefined,
      websiteUrl: officialSite?.url,
      confidence: officialSite ? 0.9 : searchResult.results.length > 0 ? 0.6 : 0.2,
      alternativeNames: [],
    };
  },
});

// ============================================================================
// Helper Functions
// ============================================================================

function getTrustScore(url: string): number {
  // SUPERSEDED by gardener/src/lib/trusted-sources.ts (trusted_review_sources table)
  const trustedDomains: Record<string, number> = {
    'rei.com': 0.95,
    'backcountry.com': 0.9,
    'outdoorgearlab.com': 0.9,
    'switchbacktravel.com': 0.85,
    'cleverhiker.com': 0.85,
    'sectionhiker.com': 0.8,
    'trailspace.com': 0.8,
    'gearjunkie.com': 0.75,
  };

  for (const [domain, score] of Object.entries(trustedDomains)) {
    if (url.includes(domain)) {
      return score;
    }
  }

  // Brand sites get moderate trust
  if (url.match(/\.(com|net|org)\/(product|shop|gear)/i)) {
    return 0.7;
  }

  return 0.5;
}

// ============================================================================
// System Prompt
// ============================================================================

const RESEARCHER_PROMPT = `You are a Researcher agent specializing in outdoor gear and equipment.
Your job is to gather comprehensive product information from the web.

## Your Capabilities

- **searchWeb**: Search for product information, reviews, and specifications
- **scrapeUrl**: Get detailed content from specific URLs
- **verifyBrand**: Verify brand existence and find official websites

## Research Guidelines

1. **Be Thorough**: Search multiple sources for comprehensive data
2. **Verify Information**: Cross-reference specs across multiple sources
3. **Prioritize Trust**: Weight information from trusted sources (REI, OutdoorGearLab, etc.) higher
4. **Note Confidence**: Track how confident you are in each piece of data
5. **Find Context**: Look for usage scenarios, comparisons, and user feedback

## Information to Gather

- Basic specs: weight, price, dimensions, materials, colors
- Brand information and verification
- Product family and variants
- Technologies and construction details
- Usage scenarios and suitability
- User feedback patterns (praise and complaints)
- Performance metrics
- Temperature/weather ratings
- Comparisons with similar products
- Sustainability information

## Output Format

Structure your findings as JSON with confidence scores for each field.
Include source URLs for all information found.`;

// ============================================================================
// Agent Configuration
// ============================================================================

let researcherAgentInstance: Agent | null = null;

const researcherTools = {
  searchWeb: searchWebTool,
  scrapeUrl: scrapeUrlTool,
  verifyBrand: verifyBrandTool,
};

/**
 * Get the Researcher Agent instance (lazy initialization)
 */
export function getResearcherAgentV2(): Agent {
  if (!researcherAgentInstance) {
    const deepseek = createDeepSeek({
      apiKey: process.env.DEEPSEEK_API_KEY ?? '',
    });

    researcherAgentInstance = new Agent({
      id: 'researcher-v2',
      name: 'Researcher',
      instructions: RESEARCHER_PROMPT,
      model: deepseek('deepseek-reasoner'),
      tools: researcherTools,
      // Note: Memory integration pending @mastra/memory package version alignment
      // memory: getResearchMemory(),
    });

    registerAgent('researcher-v2', researcherAgentInstance);
  }

  return researcherAgentInstance;
}

// ============================================================================
// High-Level Research API
// ============================================================================

export interface ResearchRequest {
  nodeId: string;
  nodeName: string;
  brand?: string;
  category?: string;
  missingFields: string[];
  priority: number;
}

export interface ResearchResult {
  nodeId: string;
  nodeName: string;
  success: boolean;
  findings: Record<string, unknown>;
  sources: Array<{ url: string; trustScore: number }>;
  confidence: number;
  error?: string;
}

/**
 * Research a product item using the Mastra Researcher agent
 */
export async function researchItem(request: ResearchRequest): Promise<ResearchResult> {
  const agent = getResearcherAgentV2();

  const prompt = `Research the following outdoor gear product:

Product: ${request.nodeName}
${request.brand ? `Brand: ${request.brand}` : ''}
${request.category ? `Category: ${request.category}` : ''}

Missing information we need:
${request.missingFields.map(f => `- ${f}`).join('\n')}

Search for comprehensive information about this product and return structured findings.
Focus especially on the missing fields listed above.`;

  try {
    const response = await agent.generate(prompt);

    // Extract structured data from the response
    let findings: Record<string, unknown> = {};
    const sources: Array<{ url: string; trustScore: number }> = [];

    try {
      // Try to parse JSON from the response
      const jsonMatch = response.text.match(/```json\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        findings = JSON.parse(jsonMatch[1]!);
      }
    } catch {
      // If parsing fails, use raw text
      findings = { rawText: response.text };
    }

    // Extract sources from tool results if available
    if (response.toolResults) {
      for (const toolResult of response.toolResults) {
        if (toolResult.payload.toolName === 'searchWeb' && toolResult.payload.result) {
          const searchResult = toolResult.payload.result as { results?: Array<{ url: string; trustScore: number }> };
          if (searchResult.results) {
            sources.push(...searchResult.results);
          }
        }
      }
    }

    return {
      nodeId: request.nodeId,
      nodeName: request.nodeName,
      success: true,
      findings,
      sources,
      confidence: sources.length > 0 ? Math.min(0.9, sources.length * 0.15) : 0.3,
    };
  } catch (error) {
    return {
      nodeId: request.nodeId,
      nodeName: request.nodeName,
      success: false,
      findings: {},
      sources: [],
      confidence: 0,
      error: error instanceof Error ? error.message : 'Research failed',
    };
  }
}

// ============================================================================
// Exports
// ============================================================================

export { researcherTools };
export default getResearcherAgentV2;
