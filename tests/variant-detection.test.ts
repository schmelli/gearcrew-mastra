import { describe, it, expect } from "vitest";
import {
  normalizeGenderName,
  normalizeSizeName,
  normalizeGenerationName,
} from "../gardener/src/workflows/variant-detection.js";

describe("normalizeGenderName", () => {
  it("strips Men's suffix", () =>
    expect(normalizeGenderName("Arc'teryx Atom LT Men's")).toBe("Arc'teryx Atom LT"));
  it("strips Women's suffix", () =>
    expect(normalizeGenderName("Arc'teryx Atom LT Women's")).toBe("Arc'teryx Atom LT"));
  it("handles Damen", () =>
    expect(normalizeGenderName("Mammut Nordwand Damen Jacke")).toBe("Mammut Nordwand Jacke"));
  it("returns unchanged when no gender", () =>
    expect(normalizeGenderName("Black Diamond Spot")).toBe("Black Diamond Spot"));
});

describe("normalizeSizeName", () => {
  it("strips 35L", () =>
    expect(normalizeSizeName("Osprey Atmos AG 35L")).toBe("Osprey Atmos AG"));
  it("strips 65 L with space", () =>
    expect(normalizeSizeName("Osprey Atmos AG 65 L")).toBe("Osprey Atmos AG"));
  it("handles lowercase l", () =>
    expect(normalizeSizeName("Hyperlite 3400 Southwest 55l")).toBe("Hyperlite 3400 Southwest"));
});

describe("normalizeGenerationName", () => {
  it("strips year", () =>
    expect(normalizeGenerationName("MSR WhisperLite 2024")).toBe("MSR WhisperLite"));
  it("strips V2", () =>
    expect(normalizeGenerationName("Nemo Tensor V2")).toBe("Nemo Tensor"));
  it("strips II", () =>
    expect(normalizeGenerationName("Big Agnes Fly Creek HV UL2 II")).toBe(
      "Big Agnes Fly Creek HV UL2",
    ));
});
