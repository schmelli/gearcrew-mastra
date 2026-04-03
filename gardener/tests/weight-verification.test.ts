import { describe, it, expect } from "vitest";
import {
  extractWeightsFromText,
  crossReferenceWeights,
} from "../src/workflows/weight-verification.js";

describe("extractWeightsFromText", () => {
  it("extracts grams", () =>
    expect(extractWeightsFromText("Weight: 450g")).toContain(450));

  it("extracts with space", () =>
    expect(extractWeightsFromText("450 grams")).toContain(450));

  it("extracts ounces and converts", () => {
    const weights = extractWeightsFromText("15.9 oz");
    expect(weights[0]).toBeCloseTo(451, 0);
  });

  // Important #5: assert exactly 1 result to prove no double-counting
  it("lb+oz does not double-count the oz portion", () => {
    const weights = extractWeightsFromText("1 lb 4 oz");
    expect(weights).toHaveLength(1);  // critical: must be exactly 1
    expect(weights[0]).toBeCloseTo(567, 0);
  });

  // Important #7: lbs plural form
  it("handles lbs plural", () => {
    const weights = extractWeightsFromText("2 lbs 3 oz");
    expect(weights).toHaveLength(1);
    expect(weights[0]).toBeCloseTo(992, 0); // 2*453.592 + 3*28.3495 = 907.184 + 85.049 = 992
  });

  it("ignores unrealistic values", () => {
    expect(extractWeightsFromText("5g micro")).toHaveLength(0); // too light
    expect(extractWeightsFromText("100000g")).toHaveLength(0); // too heavy
  });

  it("handles multiple weights in text", () => {
    const weights = extractWeightsFromText("Regular: 450g, Large: 520g");
    expect(weights).toHaveLength(2);
  });
});

describe("crossReferenceWeights", () => {
  it("returns high when 2+ sources agree", () => {
    const result = crossReferenceWeights(450, [
      { weight: 448, url: "rei.com" },
      { weight: 452, url: "backcountry.com" },
    ]);
    expect(result.newConfidence).toBe("high");
  });

  it("returns medium for single agreeing source", () => {
    const result = crossReferenceWeights(450, [
      { weight: 448, url: "forum.com" },
    ]);
    expect(result.newConfidence).toBe("medium");
  });

  it("returns low when sources disagree significantly", () => {
    const result = crossReferenceWeights(450, [
      { weight: 600, url: "somesite.com" },
    ]);
    expect(result.newConfidence).toBe("low");
    expect(result.verified).toBe(false);
  });

  it("tolerance is exactly 10%", () => {
    // 450 * 1.10 = 495 -> should still agree
    const result = crossReferenceWeights(450, [
      { weight: 495, url: "site.com" },
    ]);
    expect(result.verified).toBe(true);
  });

  it("rejects weights just outside tolerance", () => {
    const result = crossReferenceWeights(450, [
      { weight: 496, url: "site.com" },
    ]);
    expect(result.verified).toBe(false);
  });

  // Important #6: single trusted source → "high"
  it("single rei.com source upgrades to high", () => {
    const result = crossReferenceWeights(450, [{ weight: 448, url: "https://rei.com/product/123" }]);
    expect(result.newConfidence).toBe("high");
    expect(result.verified).toBe(true);
  });

  it("two sources agree → high (different from single trusted)", () => {
    const result = crossReferenceWeights(450, [
      { weight: 448, url: "https://somesite.com" },
      { weight: 452, url: "https://othersite.com" },
    ]);
    expect(result.newConfidence).toBe("high");
  });

  // Verify Critical #1 fix: spoofable domain like "notrei.com" must NOT be trusted
  it("notrei.com is not treated as rei.com (anti-spoof check)", () => {
    const result = crossReferenceWeights(450, [{ weight: 448, url: "https://notrei.com/product" }]);
    // Only 1 non-trusted source → medium, not high
    expect(result.newConfidence).toBe("medium");
  });

  // Verify Critical #2 fix: same URL with two weights only counts once
  it("same URL deduplicated - single source from same page stays medium", () => {
    const result = crossReferenceWeights(450, [
      { weight: 450, url: "https://somesite.com/page" },
      { weight: 451, url: "https://somesite.com/page" },
    ]);
    // Both entries have the same URL → deduplicated to 1 → medium, not high
    expect(result.newConfidence).toBe("medium");
  });
});
