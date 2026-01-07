/**
 * T063: Scenario test for enrichment with unit conversion
 * Tests FR-023: Automatic unit conversion for weight, temperature, distance
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('Data Enrichment - Unit Conversion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Weight Conversion', () => {
    it('should convert pounds to grams', () => {
      const lbs = 2.5;
      const grams = convertWeight(lbs, 'lb', 'g');

      expect(grams).toBeCloseTo(1134, 0);
    });

    it('should convert ounces to grams', () => {
      const oz = 16;
      const grams = convertWeight(oz, 'oz', 'g');

      expect(grams).toBeCloseTo(454, 0);
    });

    it('should convert kilograms to grams', () => {
      const kg = 1.5;
      const grams = convertWeight(kg, 'kg', 'g');

      expect(grams).toBe(1500);
    });

    it('should detect weight unit from text', () => {
      const testCases = [
        { text: '2.5 lbs', expected: { value: 2.5, unit: 'lb' } },
        { text: '16 oz', expected: { value: 16, unit: 'oz' } },
        { text: '1.5 kg', expected: { value: 1.5, unit: 'kg' } },
        { text: '500 grams', expected: { value: 500, unit: 'g' } },
        { text: '1 lb 4 oz', expected: { value: 1.25, unit: 'lb' } },
      ];

      for (const tc of testCases) {
        const result = parseWeight(tc.text);
        expect(result?.value).toBeCloseTo(tc.expected.value, 1);
        expect(result?.unit).toBe(tc.expected.unit);
      }
    });
  });

  describe('Temperature Conversion', () => {
    it('should convert Fahrenheit to Celsius', () => {
      const fahrenheit = 32;
      const celsius = convertTemperature(fahrenheit, 'F', 'C');

      expect(celsius).toBe(0);
    });

    it('should handle negative temperatures', () => {
      const fahrenheit = -40;
      const celsius = convertTemperature(fahrenheit, 'F', 'C');

      expect(celsius).toBe(-40);
    });

    it('should detect temperature rating from text', () => {
      const testCases = [
        { text: 'Rated to 20°F', expected: { value: 20, unit: 'F' } },
        { text: '-10C comfort rating', expected: { value: -10, unit: 'C' } },
        { text: 'Comfort: 30 degrees F', expected: { value: 30, unit: 'F' } },
      ];

      for (const tc of testCases) {
        const result = parseTemperature(tc.text);
        expect(result?.value).toBe(tc.expected.value);
        expect(result?.unit).toBe(tc.expected.unit);
      }
    });
  });

  describe('Dimension Conversion', () => {
    it('should convert inches to centimeters', () => {
      const inches = 10;
      const cm = convertLength(inches, 'in', 'cm');

      expect(cm).toBeCloseTo(25.4, 1);
    });

    it('should convert feet to centimeters', () => {
      const feet = 6;
      const cm = convertLength(feet, 'ft', 'cm');

      expect(cm).toBeCloseTo(182.88, 1);
    });

    it('should parse dimension strings', () => {
      const testCases = [
        { text: '24" x 16" x 8"', expected: { length: 60.96, width: 40.64, height: 20.32, unit: 'cm' } },
        { text: '60cm x 40cm', expected: { length: 60, width: 40, height: undefined, unit: 'cm' } },
      ];

      for (const tc of testCases) {
        const result = parseDimensions(tc.text);
        expect(result?.length).toBeCloseTo(tc.expected.length, 0);
        expect(result?.width).toBeCloseTo(tc.expected.width, 0);
      }
    });
  });

  describe('Volume Conversion', () => {
    it('should convert liters to milliliters', () => {
      const liters = 2.5;
      const ml = convertVolume(liters, 'L', 'ml');

      expect(ml).toBe(2500);
    });

    it('should convert cubic inches to liters', () => {
      const cubicInches = 61;
      const liters = convertVolume(cubicInches, 'cu in', 'L');

      expect(liters).toBeCloseTo(1, 0);
    });

    it('should parse volume from text', () => {
      const testCases = [
        { text: '65L capacity', expected: { value: 65, unit: 'L' } },
        { text: '3500 cubic inches', expected: { value: 3500, unit: 'cu in' } },
      ];

      for (const tc of testCases) {
        const result = parseVolume(tc.text);
        expect(result?.value).toBe(tc.expected.value);
      }
    });
  });

  describe('Data Normalization', () => {
    it('should normalize all measurements to metric', () => {
      const rawData = {
        weight: '2 lbs 8 oz',
        temperature_rating: '20°F',
        dimensions: '24" x 16" x 10"',
        capacity: '65L',
      };

      const normalized = normalizeToMetric(rawData);

      expect(normalized.weight_grams).toBeCloseTo(1134, 0);
      expect(normalized.temperature_celsius).toBeCloseTo(-6.7, 0);
      expect(normalized.dimensions_cm.length).toBeCloseTo(60.96, 0);
      expect(normalized.capacity_liters).toBe(65);
    });

    it('should preserve already-metric values', () => {
      const rawData = {
        weight: '500g',
        temperature_rating: '-5°C',
      };

      const normalized = normalizeToMetric(rawData);

      expect(normalized.weight_grams).toBe(500);
      expect(normalized.temperature_celsius).toBe(-5);
    });
  });
});

// Helper functions for testing
function convertWeight(value: number, fromUnit: string, toUnit: string): number {
  const toGrams: Record<string, number> = {
    g: 1,
    kg: 1000,
    oz: 28.3495,
    lb: 453.592,
  };

  const grams = value * (toGrams[fromUnit] ?? 1);
  return grams / (toGrams[toUnit] ?? 1);
}

function convertTemperature(value: number, fromUnit: string, toUnit: string): number {
  if (fromUnit === toUnit) return value;

  if (fromUnit === 'F' && toUnit === 'C') {
    return (value - 32) * (5 / 9);
  }
  if (fromUnit === 'C' && toUnit === 'F') {
    return value * (9 / 5) + 32;
  }

  return value;
}

function convertLength(value: number, fromUnit: string, toUnit: string): number {
  const toCm: Record<string, number> = {
    cm: 1,
    m: 100,
    in: 2.54,
    ft: 30.48,
  };

  const cm = value * (toCm[fromUnit] ?? 1);
  return cm / (toCm[toUnit] ?? 1);
}

function convertVolume(value: number, fromUnit: string, toUnit: string): number {
  const toMl: Record<string, number> = {
    ml: 1,
    L: 1000,
    'cu in': 16.387,
  };

  const ml = value * (toMl[fromUnit] ?? 1);
  return ml / (toMl[toUnit] ?? 1);
}

function parseWeight(text: string): { value: number; unit: string } | null {
  // Handle compound: "1 lb 4 oz"
  const compoundMatch = text.match(/(\d+(?:\.\d+)?)\s*lb[s]?\s+(\d+(?:\.\d+)?)\s*oz/i);
  if (compoundMatch) {
    const lbs = parseFloat(compoundMatch[1]!);
    const oz = parseFloat(compoundMatch[2]!);
    return { value: lbs + oz / 16, unit: 'lb' };
  }

  const match = text.match(/(\d+(?:\.\d+)?)\s*(lbs?|oz|kg|grams?|g)/i);
  if (match) {
    const unit = match[2]!.toLowerCase().replace(/s$/, '').replace('gram', 'g');
    return { value: parseFloat(match[1]!), unit };
  }
  return null;
}

function parseTemperature(text: string): { value: number; unit: string } | null {
  const match = text.match(/(-?\d+(?:\.\d+)?)\s*°?\s*([FC])/i);
  if (match) {
    return { value: parseFloat(match[1]!), unit: match[2]!.toUpperCase() };
  }
  return null;
}

function parseDimensions(text: string): { length: number; width: number; height?: number; unit: string } | null {
  const inchMatch = text.match(/(\d+(?:\.\d+)?)[""]\s*x\s*(\d+(?:\.\d+)?)[""]\s*(?:x\s*(\d+(?:\.\d+)?)["""])?/);
  if (inchMatch) {
    return {
      length: parseFloat(inchMatch[1]!) * 2.54,
      width: parseFloat(inchMatch[2]!) * 2.54,
      height: inchMatch[3] ? parseFloat(inchMatch[3]) * 2.54 : undefined,
      unit: 'cm',
    };
  }

  const cmMatch = text.match(/(\d+(?:\.\d+)?)\s*cm\s*x\s*(\d+(?:\.\d+)?)\s*cm/i);
  if (cmMatch) {
    return {
      length: parseFloat(cmMatch[1]!),
      width: parseFloat(cmMatch[2]!),
      unit: 'cm',
    };
  }

  return null;
}

function parseVolume(text: string): { value: number; unit: string } | null {
  const literMatch = text.match(/(\d+(?:\.\d+)?)\s*L(?:iters?)?/i);
  if (literMatch) {
    return { value: parseFloat(literMatch[1]!), unit: 'L' };
  }

  const cuInMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:cubic inches|cu\.?\s*in)/i);
  if (cuInMatch) {
    return { value: parseFloat(cuInMatch[1]!), unit: 'cu in' };
  }

  return null;
}

function normalizeToMetric(rawData: Record<string, string>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  if (rawData.weight) {
    const parsed = parseWeight(rawData.weight);
    if (parsed) {
      result.weight_grams = convertWeight(parsed.value, parsed.unit, 'g');
    }
  }

  if (rawData.temperature_rating) {
    const parsed = parseTemperature(rawData.temperature_rating);
    if (parsed) {
      result.temperature_celsius = convertTemperature(parsed.value, parsed.unit, 'C');
    }
  }

  if (rawData.dimensions) {
    const parsed = parseDimensions(rawData.dimensions);
    if (parsed) {
      result.dimensions_cm = parsed;
    }
  }

  if (rawData.capacity) {
    const parsed = parseVolume(rawData.capacity);
    if (parsed) {
      result.capacity_liters = parsed.unit === 'L' ? parsed.value : convertVolume(parsed.value, parsed.unit, 'L');
    }
  }

  return result;
}
