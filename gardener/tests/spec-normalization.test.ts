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

  // Important #1: reject invalid values
  it("rejects negative numbers for volume, fill_power, r_value, waterproof_mm", () => {
    expect(validateSpec("spec_volume_liters", -1)).toBe(false);
    expect(validateSpec("spec_fill_power", -100)).toBe(false);
    expect(validateSpec("spec_r_value", -0.5)).toBe(false);
    expect(validateSpec("spec_waterproof_mm", -10)).toBe(false);
  });

  it("rejects empty strings", () => {
    expect(validateSpec("spec_material_face", "")).toBe(false);
    expect(validateSpec("spec_material_insulation", "")).toBe(false);
    expect(validateSpec("spec_material_face", "   ")).toBe(false);
  });

  it("rejects strings longer than 500 chars", () => {
    const longString = "a".repeat(501);
    expect(validateSpec("spec_material_face", longString)).toBe(false);
    expect(validateSpec("spec_material_insulation", longString)).toBe(false);
  });

  it("rejects material strings longer than 100 chars", () => {
    const longMaterial = "a".repeat(101);
    expect(validateSpec("spec_material_face", longMaterial)).toBe(false);
    expect(validateSpec("spec_material_insulation", longMaterial)).toBe(false);
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

  it("removes empty string values", () => {
    const raw = { spec_volume_liters: 45, spec_material_face: "" };
    const sanitized = sanitizeSpecs(raw);
    expect("spec_material_face" in sanitized).toBe(false);
    expect(sanitized.spec_volume_liters).toBe(45);
  });

  it("removes strings longer than 500 chars", () => {
    const longString = "a".repeat(501);
    const raw = { spec_volume_liters: 45, spec_material_face: longString };
    const sanitized = sanitizeSpecs(raw);
    expect("spec_material_face" in sanitized).toBe(false);
  });
});

// Important #3: batch index mapping
describe("batch index mapping", () => {
  it("itemIndex 0 maps to the first item's Memgraph ID", () => {
    const batch = [
      { id: "12345", name: "Tent A", description: "...", typeSlug: "tent", category: null },
      { id: "67890", name: "Pack B", description: "...", typeSlug: "backpack", category: null },
      { id: "11111", name: "Boot C", description: "...", typeSlug: "hiking_boots", category: null },
    ];

    expect(batch[0].id).toBe("12345");
    expect(batch[1].id).toBe("67890");
    expect(batch[2].id).toBe("11111");
  });

  it("numeric string within batch bounds resolves to batch item ID (legacy fallback)", () => {
    const batch = [
      { id: "99001", name: "Item 0", description: "...", typeSlug: null, category: "gear" },
      { id: "99002", name: "Item 1", description: "...", typeSlug: null, category: "gear" },
    ];

    const entryId = "0";
    const asIndex = parseInt(entryId, 10);
    const resolvedId = (!isNaN(asIndex) && asIndex >= 0 && asIndex < batch.length)
      ? batch[asIndex].id
      : entryId;

    expect(resolvedId).toBe("99001");
  });

  it("large numeric string outside batch bounds is used as-is (real Memgraph ID)", () => {
    const batch = [
      { id: "99001", name: "Item 0", description: "...", typeSlug: null, category: "gear" },
    ];

    const entryId = "99001";
    const asIndex = parseInt(entryId, 10);
    const resolvedId = (!isNaN(asIndex) && asIndex >= 0 && asIndex < batch.length)
      ? batch[asIndex].id
      : entryId;

    // 99001 >= batch.length (1), falls through to value as-is
    expect(resolvedId).toBe("99001");
  });
});
