import { describe, it, expect } from "vitest";
import { brandCompleteness, gearItemCompleteness } from "../lib/completeness";

/**
 * Data Quality Eval
 *
 * Tests that the brand-enrichment workflow actually improves completeness.
 * Method: Compare completenessScore before and after.
 * Target: Average improvement > 0.2 per run on brands with score < 0.5
 */

describe("Data Quality — Completeness Scoring", () => {
  describe("brandCompleteness", () => {
    it("should return 0.05 for a brand with only a name", () => {
      const score = brandCompleteness({ name: "TestBrand" }, {
        productCount: 0,
        familyCount: 0,
        technologyCount: 0,
      });
      expect(score).toBe(0.05);
    });

    it("should return higher score with more fields filled", () => {
      const minimal = brandCompleteness({ name: "TestBrand" }, {
        productCount: 0,
        familyCount: 0,
        technologyCount: 0,
      });

      const enriched = brandCompleteness(
        {
          name: "TestBrand",
          description: "A test brand for outdoor gear",
          website: "https://testbrand.com",
          country: "USA",
          yearFounded: 2000,
          bestKnownFor: "Tents",
        },
        {
          productCount: 15,
          familyCount: 5,
          technologyCount: 2,
        },
      );

      expect(enriched).toBeGreaterThan(minimal);
      expect(enriched - minimal).toBeGreaterThan(0.2);
    });

    it("should cap product contribution at 10 products", () => {
      const with10 = brandCompleteness({ name: "B" }, {
        productCount: 10,
        familyCount: 0,
        technologyCount: 0,
      });

      const with100 = brandCompleteness({ name: "B" }, {
        productCount: 100,
        familyCount: 0,
        technologyCount: 0,
      });

      expect(with10).toBe(with100);
    });

    it("should cap family contribution at 5 families", () => {
      const with5 = brandCompleteness({ name: "B" }, {
        productCount: 0,
        familyCount: 5,
        technologyCount: 0,
      });

      const with50 = brandCompleteness({ name: "B" }, {
        productCount: 0,
        familyCount: 50,
        technologyCount: 0,
      });

      expect(with5).toBe(with50);
    });

    it("should reach >0.8 for a fully enriched brand", () => {
      const score = brandCompleteness(
        {
          name: "Full Brand",
          description: "Complete description",
          website: "https://fullbrand.com",
          country: "Germany",
          yearFounded: 1990,
          bestKnownFor: "Everything",
        },
        {
          productCount: 20,
          familyCount: 8,
          technologyCount: 3,
        },
      );

      expect(score).toBeGreaterThan(0.8);
    });
  });

  describe("gearItemCompleteness", () => {
    it("should return low score for minimal item", () => {
      const score = gearItemCompleteness({
        name: "Some Tent",
        brand: "TestBrand",
      });
      expect(score).toBeLessThan(0.3);
    });

    it("should return high score for complete item", () => {
      const score = gearItemCompleteness({
        name: "Hubba Hubba NX 2",
        brand: "MSR",
        description: "A 2-person backpacking tent",
        category: "Tent",
        weight_grams: 1720,
        price_usd: 449.95,
        features: ["Freestanding", "Double-wall"],
        gearId: "msr_hubba-hubba-nx-2",
        sourceUrl: "https://msr.com/hubba-hubba",
        year: 2024,
        imageUrl: "https://msr.com/images/hubba.jpg",
      });
      expect(score).toBeGreaterThan(0.8);
    });
  });
});
