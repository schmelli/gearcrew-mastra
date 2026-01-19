/**
 * Enrichment Specifications Configuration
 *
 * Defines which specifications are relevant for each product category.
 * Used by the Enricher Agent to determine what data to research.
 *
 * Principle: Only research specs that make sense for the category.
 * - Tents need capacity_persons, not volume_liters
 * - Backpacks need volume_liters, not temperature_rating
 */

// =============================================================================
// Spec Field Definitions
// =============================================================================

/**
 * All possible specification fields that can be enriched
 */
export type SpecField =
  | 'weight_grams'
  | 'dimensions_cm'
  | 'volume_liters'
  | 'materials'
  | 'temperature_rating'
  | 'size'
  | 'capacity_persons'
  | 'season_rating'
  | 'frame_type'
  | 'fuel_type'
  | 'connector_type'
  | 'construction_type';

/**
 * Metadata for each spec field
 */
export interface SpecFieldMeta {
  /** Display name for the field */
  label: string;
  /** Description for the agent to understand what to research */
  description: string;
  /** Data type */
  type: 'number' | 'string' | 'enum';
  /** Unit of measurement (if applicable) */
  unit?: string;
  /** Allowed values (for enum types) */
  allowedValues?: string[];
  /** Search keywords to help the agent find this information */
  searchHints: string[];
}

/**
 * Complete spec field definitions
 */
export const SPEC_FIELDS: Record<SpecField, SpecFieldMeta> = {
  weight_grams: {
    label: 'Weight',
    description: 'Total weight of the product including stuff sack/packaging',
    type: 'number',
    unit: 'grams',
    searchHints: ['weight', 'gewicht', 'grams', 'oz', 'ounces', 'lbs', 'pounds', 'trail weight', 'packed weight'],
  },

  dimensions_cm: {
    label: 'Dimensions',
    description: 'Packed dimensions (length x width x height) in centimeters',
    type: 'string',
    unit: 'cm',
    searchHints: ['dimensions', 'size', 'packed size', 'folded size', 'maße', 'abmessungen'],
  },

  volume_liters: {
    label: 'Volume',
    description: 'Internal capacity/volume in liters',
    type: 'number',
    unit: 'liters',
    searchHints: ['volume', 'capacity', 'liters', 'litres', 'volumen', 'fassungsvermögen'],
  },

  materials: {
    label: 'Materials',
    description: 'Primary materials used (fabric, fill, construction materials)',
    type: 'string',
    searchHints: ['material', 'fabric', 'fill', 'construction', 'nylon', 'polyester', 'down', 'synthetic', 'silnylon', 'dyneema', 'cuben fiber'],
  },

  temperature_rating: {
    label: 'Temperature Rating',
    description: 'Comfort or limit temperature rating in Celsius',
    type: 'number',
    unit: 'celsius',
    searchHints: ['temperature', 'temp rating', 'comfort rating', 'limit rating', 'EN rating', 'ISO rating', 'R-value'],
  },

  size: {
    label: 'Size',
    description: 'Size designation (S, M, L, XL, or specific measurements)',
    type: 'string',
    searchHints: ['size', 'größe', 'fit', 'sizing', 'length', 'regular', 'long', 'wide'],
  },

  capacity_persons: {
    label: 'Person Capacity',
    description: 'Number of persons the shelter/hammock is designed for',
    type: 'number',
    unit: 'persons',
    searchHints: ['person', 'capacity', 'sleeps', 'man tent', 'personen', 'plätze', '1P', '2P', '3P'],
  },

  season_rating: {
    label: 'Season Rating',
    description: 'Seasonal suitability of the product',
    type: 'enum',
    allowedValues: ['3-season', '3.5-season', '4-season', 'summer', 'winter'],
    searchHints: ['season', '3-season', '4-season', 'all-season', 'winter', 'summer', 'jahreszeit'],
  },

  frame_type: {
    label: 'Frame Type',
    description: 'Type of frame/support structure in backpacks',
    type: 'enum',
    allowedValues: ['internal', 'external', 'frameless', 'removable'],
    searchHints: ['frame', 'internal frame', 'external frame', 'frameless', 'stay', 'framesheet', 'gestell'],
  },

  fuel_type: {
    label: 'Fuel Type',
    description: 'Type of fuel the stove uses',
    type: 'enum',
    allowedValues: ['canister', 'alcohol', 'wood', 'solid', 'multi-fuel', 'white-gas', 'propane'],
    searchHints: ['fuel', 'brennstoff', 'canister', 'alcohol', 'wood burning', 'esbit', 'iso-butane', 'propane'],
  },

  connector_type: {
    label: 'Connector Type',
    description: 'Charging/power connector standard',
    type: 'enum',
    allowedValues: ['usb-c', 'usb-a', 'micro-usb', 'usb-mini', 'lightning', 'proprietary'],
    searchHints: ['USB', 'USB-C', 'Type-C', 'micro USB', 'charging', 'port', 'connector', 'anschluss'],
  },

  construction_type: {
    label: 'Construction Type',
    description: 'Tent construction style',
    type: 'enum',
    allowedValues: ['freestanding', 'semi-freestanding', 'non-freestanding', 'trekking-pole', 'a-frame', 'tunnel', 'dome', 'pyramid'],
    searchHints: ['freestanding', 'non-freestanding', 'trekking pole', 'tunnel', 'dome', 'pyramid', 'aufbau'],
  },
};

// =============================================================================
// Category-to-Specs Mapping
// =============================================================================

/**
 * Specs required for each subcategory
 * Key format: "category/subcategory" or "category/subcategory/productType"
 */
export const CATEGORY_SPECS: Record<string, SpecField[]> = {
  // -------------------------------------------------------------------------
  // SHELTER
  // -------------------------------------------------------------------------
  'shelter/tents': [
    'weight_grams',
    'dimensions_cm',
    'materials',
    'capacity_persons',
    'season_rating',
    'construction_type',
  ],
  'shelter/tarps': [
    'weight_grams',
    'dimensions_cm',
    'materials',
  ],
  'shelter/bivys': [
    'weight_grams',
    'dimensions_cm',
    'materials',
  ],
  'shelter/hammocks': [
    'weight_grams',
    'dimensions_cm',
    'materials',
    'capacity_persons',
  ],

  // -------------------------------------------------------------------------
  // SLEEP SYSTEM
  // -------------------------------------------------------------------------
  'sleep-system/sleeping-bags': [
    'weight_grams',
    'dimensions_cm',
    'materials',
    'temperature_rating',
    'size',
    'season_rating',
  ],
  'sleep-system/sleeping-pads': [
    'weight_grams',
    'dimensions_cm',
    'materials',
    'temperature_rating', // R-value
  ],
  'sleep-system/pillows': [
    'weight_grams',
    'dimensions_cm',
  ],

  // -------------------------------------------------------------------------
  // PACKS & BAGS
  // -------------------------------------------------------------------------
  'packs/backpacks': [
    'weight_grams',
    'volume_liters',
    'materials',
    'size',
    'frame_type',
  ],
  'packs/stuff-sacks': [
    'weight_grams',
    'volume_liters',
    'materials',
  ],
  'packs/pack-accessories': [
    'weight_grams',
    'volume_liters',
  ],

  // -------------------------------------------------------------------------
  // CLOTHING
  // -------------------------------------------------------------------------
  'clothing/base-layers': [
    'weight_grams',
    'materials',
    'size',
  ],
  'clothing/insulation': [
    'weight_grams',
    'materials',
    'temperature_rating',
    'size',
  ],
  'clothing/rain-gear': [
    'weight_grams',
    'materials',
    'size',
  ],
  'clothing/headwear': [
    'weight_grams',
    'materials',
    'size',
  ],
  'clothing/footwear': [
    'weight_grams',
    'materials',
    'size',
  ],

  // -------------------------------------------------------------------------
  // COOKING
  // -------------------------------------------------------------------------
  'cooking/stoves': [
    'weight_grams',
    'dimensions_cm',
    'materials',
    'fuel_type',
  ],
  'cooking/cookware': [
    'weight_grams',
    'volume_liters',
    'dimensions_cm',
    'materials',
  ],
  'cooking/utensils': [
    'weight_grams',
    'dimensions_cm',
    'materials',
  ],
  'cooking/fuel': [
    'weight_grams',
  ],

  // -------------------------------------------------------------------------
  // WATER
  // -------------------------------------------------------------------------
  'water/water-storage': [
    'weight_grams',
    'volume_liters',
    'materials',
  ],
  'water/water-treatment': [
    'weight_grams',
    'dimensions_cm',
  ],

  // -------------------------------------------------------------------------
  // ELECTRONICS
  // -------------------------------------------------------------------------
  'electronics/lighting': [
    'weight_grams',
    'dimensions_cm',
    'connector_type',
  ],
  'electronics/power': [
    'weight_grams',
    'dimensions_cm',
    'volume_liters', // mAh capacity - we'll use this field
    'connector_type',
  ],
  'electronics/communication': [
    'weight_grams',
    'dimensions_cm',
    'connector_type',
  ],

  // -------------------------------------------------------------------------
  // NAVIGATION
  // -------------------------------------------------------------------------
  'navigation/maps-compass': [
    'weight_grams',
  ],
  'navigation/gps-devices': [
    'weight_grams',
    'dimensions_cm',
    'connector_type',
  ],

  // -------------------------------------------------------------------------
  // FIRST AID
  // -------------------------------------------------------------------------
  'first-aid/first-aid-kits': [
    'weight_grams',
    'dimensions_cm',
  ],
  'first-aid/sun-protection': [
    'weight_grams',
  ],
  'first-aid/insect-protection': [
    'weight_grams',
  ],

  // -------------------------------------------------------------------------
  // TOILETRIES
  // -------------------------------------------------------------------------
  'toiletries/hygiene': [
    'weight_grams',
  ],
  'toiletries/waste-management': [
    'weight_grams',
  ],

  // -------------------------------------------------------------------------
  // MISCELLANEOUS
  // -------------------------------------------------------------------------
  'miscellaneous/repair-maintenance': [
    'weight_grams',
  ],
  'miscellaneous/trekking-poles': [
    'weight_grams',
    'dimensions_cm',
    'materials',
  ],
  'miscellaneous/accessories': [
    'weight_grams',
  ],
};

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get the specs required for a given category path
 * @param categoryPath - Format: "category/subcategory" or "category/subcategory/productType"
 * @returns Array of required spec fields
 */
export function getSpecsForCategory(categoryPath: string): SpecField[] {
  // Try exact match first
  if (CATEGORY_SPECS[categoryPath]) {
    return CATEGORY_SPECS[categoryPath];
  }

  // Try parent path (category/subcategory)
  const parts = categoryPath.split('/');
  if (parts.length === 3) {
    const parentPath = `${parts[0]}/${parts[1]}`;
    if (CATEGORY_SPECS[parentPath]) {
      return CATEGORY_SPECS[parentPath];
    }
  }

  // Default: just weight (everything has weight)
  return ['weight_grams'];
}

/**
 * Get metadata for a spec field
 */
export function getSpecFieldMeta(field: SpecField): SpecFieldMeta {
  return SPEC_FIELDS[field];
}

/**
 * Get all spec fields with their metadata
 */
export function getAllSpecFields(): Array<{ field: SpecField; meta: SpecFieldMeta }> {
  return Object.entries(SPEC_FIELDS).map(([field, meta]) => ({
    field: field as SpecField,
    meta,
  }));
}

/**
 * Build a research prompt for the enricher agent
 * @param productName - Name of the product
 * @param brandName - Brand name (optional)
 * @param categoryPath - Category path to determine which specs to research
 */
export function buildResearchPrompt(
  productName: string,
  brandName: string | null,
  categoryPath: string
): string {
  const specs = getSpecsForCategory(categoryPath);
  const specDetails = specs.map((field) => {
    const meta = SPEC_FIELDS[field];
    return `- **${meta.label}**: ${meta.description}${meta.unit ? ` (in ${meta.unit})` : ''}`;
  });

  const searchProduct = brandName ? `${brandName} ${productName}` : productName;

  return `Research the following specifications for "${searchProduct}":

${specDetails.join('\n')}

Search hints for each field:
${specs.map((field) => `- ${field}: ${SPEC_FIELDS[field].searchHints.join(', ')}`).join('\n')}

Return ONLY verified information from official sources (manufacturer website, retailers).
If a specification cannot be found, mark it as null.
Do NOT guess or estimate values.`;
}

/**
 * Validate enrichment results against expected specs
 */
export function validateEnrichmentResult(
  categoryPath: string,
  result: Record<string, unknown>
): { valid: boolean; errors: string[] } {
  const requiredSpecs = getSpecsForCategory(categoryPath);
  const errors: string[] = [];

  for (const field of requiredSpecs) {
    const meta = SPEC_FIELDS[field];
    const value = result[field];

    if (value === undefined || value === null) {
      continue; // Missing values are OK (not found)
    }

    // Type validation
    if (meta.type === 'number' && typeof value !== 'number') {
      errors.push(`${field}: expected number, got ${typeof value}`);
    }

    if (meta.type === 'string' && typeof value !== 'string') {
      errors.push(`${field}: expected string, got ${typeof value}`);
    }

    if (meta.type === 'enum' && meta.allowedValues) {
      if (!meta.allowedValues.includes(value as string)) {
        errors.push(`${field}: "${value}" is not a valid value. Allowed: ${meta.allowedValues.join(', ')}`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export default {
  SPEC_FIELDS,
  CATEGORY_SPECS,
  getSpecsForCategory,
  getSpecFieldMeta,
  getAllSpecFields,
  buildResearchPrompt,
  validateEnrichmentResult,
};
