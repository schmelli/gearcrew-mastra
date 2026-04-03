import { describe, it, expect } from "vitest";
import { validateSpec, sanitizeSpecs } from "../src/workflows/spec-normalization.js";

describe("validateSpec", () => {
  it("validates volume_liters", () => {
    expect(validateSpec("spec_volume_liters", 45)).toBe(true);
    expect(validateSpec("spec_volume_liters", -5)).toBe(false);
    expect(validateSpec("spec_volume_liters", 2000)).toBe(false);
    expect(validateSpec("spec_volume_liters", "45L")).toBe(false);
  });
  it("validates temp_rating_c", () => {
    expect(validateSpec("spec_temp_rating_c", -20)).toBe(true);
    expect(validateSpec("spec_temp_rating_c", -70)).toBe(false);
    expect(validateSpec("spec_temp_rating_c", 50)).toBe(false);
  });
  it("validates fill_power", () => {
    expect(validateSpec("spec_fill_power", 800)).toBe(true);
    expect(validateSpec("spec_fill_power", 300)).toBe(false);
    expect(validateSpec("spec_fill_power", 1300)).toBe(false);
  });
  it("validates waterproof_mm", () => {
    expect(validateSpec("spec_waterproof_mm", 10000)).toBe(true);
    expect(validateSpec("spec_waterproof_mm", -1)).toBe(false);
  });
  it("validates seasons", () => {
    expect(validateSpec("spec_seasons", 3)).toBe(true);
    expect(validateSpec("spec_seasons", 5)).toBe(false);
    expect(validateSpec("spec_seasons", 0)).toBe(false);
  });
  it("validates packed_size_cm format", () => {
    expect(validateSpec("spec_packed_size_cm", "30x15")).toBe(true);
    expect(validateSpec("spec_packed_size_cm", "30cm x 15cm")).toBe(false);
  });
});

describe("sanitizeSpecs", () => {
  it("removes invalid values", () => {
    const raw = { spec_volume_liters: 45, spec_temp_rating_c: -100 };
    const sanitized = sanitizeSpecs(raw);
    expect(sanitized.spec_volume_liters).toBe(45);
    expect(sanitized.spec_temp_rating_c).toBeUndefined();
  });
  it("removes null values", () => {
    const raw = { spec_volume_liters: 45, spec_fill_power: null };
    const sanitized = sanitizeSpecs(raw);
    expect("spec_fill_power" in sanitized).toBe(false);
  });
  it("passes valid booleans", () => {
    expect(sanitizeSpecs({ spec_poles_included: false })).toEqual({ spec_poles_included: false });
  });
});
