import { describe, it, expect } from "vitest";
import {
  normalizeGenderName,
  normalizeSizeName,
  normalizeGenerationName,
} from "../../src/workflows/variant-detection.js";

describe("normalizeGenderName", () => {
  it("strips Men's", () =>
    expect(normalizeGenderName("Arc'teryx Men's Atom LT Hoody")).toBe("Arc'teryx Atom LT Hoody"));

  it("strips Women's", () =>
    expect(normalizeGenderName("Osprey Women's Tempest 20")).toBe("Osprey Tempest 20"));

  it("strips Damen", () =>
    expect(normalizeGenderName("Mammut Damen Convey Tour")).toBe("Mammut Convey Tour"));

  it("strips Herren", () =>
    expect(normalizeGenderName("Salewa Herren Alpenrose Jacket")).toBe("Salewa Alpenrose Jacket"));

  it("normalises whitespace after stripping", () =>
    expect(normalizeGenderName("Patagonia   Men   Fleece")).toBe("Patagonia Fleece"));
});

describe("normalizeSizeName", () => {
  it("strips litre volume 35L", () =>
    expect(normalizeSizeName("Osprey Atmos 35L")).toBe("Osprey Atmos"));

  it("strips litre volume 65l (lowercase)", () =>
    expect(normalizeSizeName("Deuter Aircontact 65l")).toBe("Deuter Aircontact"));

  it("leaves name unchanged when no litres present", () =>
    expect(normalizeSizeName("Black Diamond Spot Headlamp")).toBe("Black Diamond Spot Headlamp"));
});

describe("normalizeGenerationName", () => {
  it("strips year 2024", () =>
    expect(normalizeGenerationName("MSR WhisperLite 2024")).toBe("MSR WhisperLite"));

  it("strips v2", () =>
    expect(normalizeGenerationName("Salomon X Ultra v2")).toBe("Salomon X Ultra"));

  it("strips Gen 2", () =>
    expect(normalizeGenerationName("Garmin inReach Gen 2")).toBe("Garmin inReach"));

  it("strips Roman numeral III mid-name", () =>
    expect(normalizeGenerationName("Mammut Trion III Pro")).toBe("Mammut Trion Pro"));

  it("strips year 2024 variant", () =>
    expect(normalizeGenerationName("MSR WhisperLite 2024")).toBe("MSR WhisperLite"));

  it("handles product where II appears at end (strips it)", () =>
    expect(normalizeGenerationName("Garmin inReach Mini II")).toBe("Garmin inReach Mini"));

  it("strips 2nd Gen", () =>
    expect(normalizeGenerationName("Apple Watch 2nd Gen")).toBe("Apple Watch"));

  it("normalises extra whitespace", () =>
    expect(normalizeGenerationName("Nemo Tensor   2024  Sleeping Pad")).toBe("Nemo Tensor Sleeping Pad"));
});
