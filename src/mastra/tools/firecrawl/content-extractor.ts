/**
 * T067: Content Extraction and Classification Tool
 * Implements FR-022: Extract and classify gear specs from scraped content
 */

import { z } from 'zod';
import { GearSpecs, GearSpecsSchema } from './web-search';

// Schema for extraction request
export const ExtractionRequestSchema = z.object({
  content: z.string(),
  contentType: z.enum(['markdown', 'html', 'plaintext']).default('markdown'),
  expectedCategory: z.string().optional(),
  sourceUrl: z.string().optional(),
});

export type ExtractionRequest = z.infer<typeof ExtractionRequestSchema>;

// Schema for extraction result
export const ExtractionResultSchema = z.object({
  success: z.boolean(),
  specs: GearSpecsSchema.optional(),
  rawExtractions: z
    .object({
      weight: z.string().optional(),
      price: z.string().optional(),
      dimensions: z.string().optional(),
      capacity: z.string().optional(),
      temperature: z.string().optional(),
      materials: z.array(z.string()).optional(),
      features: z.array(z.string()).optional(),
    })
    .optional(),
  warnings: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1),
});

export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;

// Category-specific extraction patterns
const CATEGORY_PATTERNS: Record<string, CategoryPatterns> = {
  backpack: {
    weightPatterns: [
      /(?:weight|wt)[:\s]*(\d+(?:\.\d+)?)\s*(g|oz|lb|kg)/gi,
      /(?:weighs?|weighing)[:\s]*(\d+(?:\.\d+)?)\s*(g|oz|lb|kg)/gi,
    ],
    capacityPatterns: [
      /(\d+)\s*(?:L|liter|litre)/gi,
      /(\d+)\s*(?:cubic\s*in|cu\.?\s*in)/gi,
      /capacity[:\s]*(\d+)/gi,
    ],
    specificFields: ['hipBelt', 'frameType', 'loadRange', 'backLength'],
  },
  tent: {
    weightPatterns: [
      /(?:packed|total|trail)\s*weight[:\s]*(\d+(?:\.\d+)?)\s*(g|oz|lb|kg)/gi,
      /(?:minimum|min)\s*weight[:\s]*(\d+(?:\.\d+)?)\s*(g|oz|lb|kg)/gi,
    ],
    dimensionPatterns: [
      /(?:floor\s*)?(?:area|size)[:\s]*(\d+)\s*[x×]\s*(\d+)/gi,
      /(?:packed\s*)?(?:size|dimensions?)[:\s]*(\d+)\s*[x×]\s*(\d+)\s*[x×]\s*(\d+)/gi,
    ],
    specificFields: ['floorArea', 'peakHeight', 'vestibuleArea', 'doors', 'poles'],
  },
  sleepingBag: {
    weightPatterns: [/(?:fill\s*)?weight[:\s]*(\d+(?:\.\d+)?)\s*(g|oz)/gi],
    temperaturePatterns: [
      /(?:comfort|lower\s*limit|extreme)[:\s]*(-?\d+)\s*°?\s*([FC])/gi,
      /(?:rated?\s*(?:to)?)[:\s]*(-?\d+)\s*°?\s*([FC])/gi,
      /(-?\d+)\s*°?\s*([FC])\s*(?:comfort|rating)/gi,
    ],
    specificFields: ['fillPower', 'fillWeight', 'shape', 'insulation'],
  },
  sleepingPad: {
    dimensionPatterns: [/(?:size|dimensions?)[:\s]*(\d+)\s*[x×]\s*(\d+)\s*(cm|in)?/gi],
    specificFields: ['rValue', 'thickness', 'packedSize'],
  },
  stove: {
    weightPatterns: [/(?:weight|wt)[:\s]*(\d+(?:\.\d+)?)\s*(g|oz)/gi],
    specificFields: ['boilTime', 'fuelType', 'burnTime', 'potSupport'],
  },
  cookware: {
    capacityPatterns: [/(\d+(?:\.\d+)?)\s*(?:ml|L|oz|cup)/gi],
    specificFields: ['material', 'coating', 'nestable'],
  },
};

interface CategoryPatterns {
  weightPatterns?: RegExp[];
  dimensionPatterns?: RegExp[];
  capacityPatterns?: RegExp[];
  temperaturePatterns?: RegExp[];
  specificFields?: string[];
}

/**
 * Content Extractor for gear specifications
 */
export class ContentExtractor {
  /**
   * Extract gear specifications from content
   */
  extract(request: ExtractionRequest): ExtractionResult {
    const { content, contentType, expectedCategory, sourceUrl } = request;

    // Clean content based on type
    const cleanContent = this.cleanContent(content, contentType);

    // Detect category if not provided
    const category = expectedCategory || this.detectCategory(cleanContent);

    // Get category-specific patterns
    const patterns = category ? CATEGORY_PATTERNS[category] : undefined;

    // Extract raw values
    const rawExtractions = this.extractRawValues(cleanContent, patterns);

    // Parse and normalize values
    const specs = this.parseExtractions(rawExtractions, sourceUrl);

    // Calculate confidence
    const confidence = this.calculateConfidence(rawExtractions);

    // Generate warnings
    const warnings = this.generateWarnings(rawExtractions, specs);

    return {
      success: confidence > 0.1,
      specs: confidence > 0.1 ? specs : undefined,
      rawExtractions,
      warnings: warnings.length > 0 ? warnings : undefined,
      confidence,
    };
  }

  /**
   * Clean and normalize content
   */
  private cleanContent(content: string, contentType: string): string {
    let cleaned = content;

    if (contentType === 'html') {
      // Remove HTML tags
      cleaned = cleaned.replace(/<[^>]+>/g, ' ');
      // Decode entities
      cleaned = cleaned
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"');
    }

    if (contentType === 'markdown') {
      // Remove markdown formatting
      cleaned = cleaned.replace(/[*_~`#]/g, '');
      cleaned = cleaned.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    }

    // Normalize whitespace
    cleaned = cleaned.replace(/\s+/g, ' ').trim();

    return cleaned;
  }

  /**
   * Detect gear category from content
   */
  private detectCategory(content: string): string | undefined {
    const contentLower = content.toLowerCase();

    const categoryKeywords: Record<string, string[]> = {
      backpack: ['backpack', 'pack', 'daypack', 'rucksack', 'hip belt', 'load lifter'],
      tent: ['tent', 'shelter', 'vestibule', 'rainfly', 'footprint', 'guy lines'],
      sleepingBag: ['sleeping bag', 'quilt', 'down fill', 'fill power', 'mummy bag'],
      sleepingPad: ['sleeping pad', 'mattress', 'r-value', 'inflatable pad'],
      stove: ['stove', 'burner', 'boil time', 'fuel canister', 'wind screen'],
      cookware: ['pot', 'pan', 'cookset', 'titanium', 'hard anodized'],
    };

    let bestMatch: { category: string; score: number } | undefined;

    for (const [category, keywords] of Object.entries(categoryKeywords)) {
      let score = 0;
      for (const keyword of keywords) {
        if (contentLower.includes(keyword)) {
          score++;
        }
      }
      if (score > 0 && (!bestMatch || score > bestMatch.score)) {
        bestMatch = { category, score };
      }
    }

    return bestMatch?.category;
  }

  /**
   * Extract raw string values from content
   */
  private extractRawValues(
    content: string,
    patterns?: CategoryPatterns
  ): ExtractionResult['rawExtractions'] {
    const raw: NonNullable<ExtractionResult['rawExtractions']> = {};

    // Weight extraction
    const weightPatterns = patterns?.weightPatterns || [
      /(?:weight|wt\.?)[:\s]*(\d+(?:\.\d+)?)\s*(g|kg|oz|lb)/gi,
    ];
    for (const pattern of weightPatterns) {
      const match = pattern.exec(content);
      if (match) {
        raw.weight = `${match[1]} ${match[2]}`;
        break;
      }
    }

    // Dimension extraction
    const dimPatterns = patterns?.dimensionPatterns || [
      /(?:dimensions?|size)[:\s]*(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(?:[x×]\s*(\d+(?:\.\d+)?))?\s*(cm|in|mm)?/gi,
    ];
    for (const pattern of dimPatterns) {
      const match = pattern.exec(content);
      if (match) {
        raw.dimensions = match[0];
        break;
      }
    }

    // Capacity extraction
    const capPatterns = patterns?.capacityPatterns || [/(\d+(?:\.\d+)?)\s*(?:L|liters?|ml)/gi];
    for (const pattern of capPatterns) {
      const match = pattern.exec(content);
      if (match) {
        raw.capacity = match[0];
        break;
      }
    }

    // Temperature extraction
    const tempPatterns = patterns?.temperaturePatterns || [
      /(?:rated?|comfort|limit)[:\s]*(-?\d+)\s*°?\s*([FC])/gi,
    ];
    for (const pattern of tempPatterns) {
      const match = pattern.exec(content);
      if (match) {
        raw.temperature = `${match[1]}°${match[2]}`;
        break;
      }
    }

    // Price extraction
    const priceMatch = content.match(/\$\s*(\d+(?:\.\d{2})?)/);
    if (priceMatch) {
      raw.price = priceMatch[0];
    }

    // Materials extraction
    const materialKeywords = [
      'nylon',
      'polyester',
      'ripstop',
      'cordura',
      'dyneema',
      'cuben fiber',
      'dcf',
      'silnylon',
      'silpoly',
      'gore-tex',
      'pertex',
      'down',
      'synthetic',
      'primaloft',
      'climashield',
      'aluminum',
      'titanium',
      'carbon fiber',
      'stainless steel',
    ];
    const foundMaterials: string[] = [];
    for (const material of materialKeywords) {
      if (content.toLowerCase().includes(material)) {
        foundMaterials.push(material);
      }
    }
    if (foundMaterials.length > 0) {
      raw.materials = foundMaterials;
    }

    // Features extraction
    const featurePatterns = [
      /features?[:\s]*([^.]+)/gi,
      /includes?[:\s]*([^.]+)/gi,
      /(?:with|has)[:\s]*([^.]+(?:pocket|loop|strap|attachment))/gi,
    ];
    const features: string[] = [];
    for (const pattern of featurePatterns) {
      const matches = content.matchAll(pattern);
      for (const match of matches) {
        features.push(match[1]!.trim());
      }
    }
    if (features.length > 0) {
      raw.features = [...new Set(features)].slice(0, 10);
    }

    return raw;
  }

  /**
   * Parse raw extractions into structured specs
   */
  private parseExtractions(
    raw: ExtractionResult['rawExtractions'],
    sourceUrl?: string
  ): GearSpecs {
    const specs: GearSpecs = {
      sourceUrl,
      scrapedAt: new Date().toISOString(),
    };

    // Parse weight
    if (raw?.weight) {
      const match = raw.weight.match(/(\d+(?:\.\d+)?)\s*(g|kg|oz|lb)/i);
      if (match) {
        specs.weight = {
          value: parseFloat(match[1]!),
          unit: match[2]!.toLowerCase() as 'g' | 'kg' | 'oz' | 'lb',
        };
      }
    }

    // Parse price
    if (raw?.price) {
      const match = raw.price.match(/\$?\s*(\d+(?:\.\d{2})?)/);
      if (match) {
        specs.price = {
          value: parseFloat(match[1]!),
          currency: 'USD',
        };
      }
    }

    // Parse dimensions
    if (raw?.dimensions) {
      const match = raw.dimensions.match(
        /(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(?:[x×]\s*(\d+(?:\.\d+)?))?\s*(cm|in|mm)?/i
      );
      if (match) {
        specs.dimensions = {
          length: parseFloat(match[1]!),
          width: parseFloat(match[2]!),
          height: match[3] ? parseFloat(match[3]) : undefined,
          unit: (match[4]?.toLowerCase() || 'cm') as 'cm' | 'in' | 'mm',
        };
      }
    }

    // Parse capacity
    if (raw?.capacity) {
      const match = raw.capacity.match(/(\d+(?:\.\d+)?)\s*(L|liters?|ml)/i);
      if (match) {
        const value = parseFloat(match[1]!);
        const unit = match[2]!.toLowerCase();
        specs.capacity = {
          value: unit === 'ml' ? value : value,
          unit: unit.startsWith('ml') ? 'ml' : 'L',
        };
      }
    }

    // Parse temperature
    if (raw?.temperature) {
      const match = raw.temperature.match(/(-?\d+)\s*°?\s*([FC])/i);
      if (match) {
        specs.temperatureRating = {
          value: parseInt(match[1]!, 10),
          unit: match[2]!.toUpperCase() as 'C' | 'F',
        };
      }
    }

    // Copy materials and features
    if (raw?.materials) {
      specs.materials = raw.materials;
    }
    if (raw?.features) {
      specs.features = raw.features;
    }

    return specs;
  }

  /**
   * Calculate extraction confidence score
   */
  private calculateConfidence(raw: ExtractionResult['rawExtractions']): number {
    if (!raw) return 0;

    let score = 0;
    const weights = {
      weight: 0.25,
      price: 0.15,
      dimensions: 0.15,
      capacity: 0.15,
      temperature: 0.1,
      materials: 0.1,
      features: 0.1,
    };

    if (raw.weight) score += weights.weight;
    if (raw.price) score += weights.price;
    if (raw.dimensions) score += weights.dimensions;
    if (raw.capacity) score += weights.capacity;
    if (raw.temperature) score += weights.temperature;
    if (raw.materials && raw.materials.length > 0) score += weights.materials;
    if (raw.features && raw.features.length > 0) score += weights.features;

    return score;
  }

  /**
   * Generate warnings about extraction quality
   */
  private generateWarnings(
    raw: ExtractionResult['rawExtractions'],
    specs: GearSpecs
  ): string[] {
    const warnings: string[] = [];

    // Check for missing critical fields
    if (!specs.weight) {
      warnings.push('Weight not found - this is a critical field for gear items');
    }

    // Check for potentially incorrect values
    if (specs.weight) {
      const weightInGrams =
        specs.weight.unit === 'kg'
          ? specs.weight.value * 1000
          : specs.weight.unit === 'lb'
            ? specs.weight.value * 453.592
            : specs.weight.unit === 'oz'
              ? specs.weight.value * 28.35
              : specs.weight.value;

      if (weightInGrams > 10000) {
        warnings.push('Weight seems unusually high for outdoor gear');
      }
      if (weightInGrams < 10) {
        warnings.push('Weight seems unusually low - verify value');
      }
    }

    // Check for incomplete dimensions
    if (specs.dimensions && !specs.dimensions.height) {
      warnings.push('Only 2D dimensions found - height/depth may be missing');
    }

    // Check for missing materials
    if (!specs.materials || specs.materials.length === 0) {
      warnings.push('No materials detected - consider manual verification');
    }

    return warnings;
  }
}

/**
 * Create a Mastra-compatible tool for content extraction
 */
export function createContentExtractorTool() {
  return {
    name: 'extractGearSpecs',
    description: 'Extract structured gear specifications from text content',
    inputSchema: ExtractionRequestSchema,
    execute: async (input: ExtractionRequest): Promise<ExtractionResult> => {
      const extractor = new ContentExtractor();
      return extractor.extract(input);
    },
  };
}
