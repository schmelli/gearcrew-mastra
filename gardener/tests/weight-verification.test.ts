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

  it("extracts lb+oz", () => {
    const weights = extractWeightsFromText("1 lb 4 oz");
    expect(weights[0]).toBeCloseTo(567, 0);
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
});
