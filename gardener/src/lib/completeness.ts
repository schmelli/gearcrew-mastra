export interface BrandStats {
  productCount: number;
  familyCount: number;
  technologyCount: number;
  hasSegment?: boolean;
  hasCompetitors?: boolean;
}

export function brandCompleteness(
  brand: Record<string, unknown>,
  stats: BrandStats,
): number {
  let score = 0;
  const weights = {
    hasName: 0.05,
    hasDescription: 0.15,
    hasWebsite: 0.1,
    hasCountry: 0.05,
    hasYearFounded: 0.05,
    hasBestKnownFor: 0.05,
    hasProducts: 0.25,
    hasProductFamilies: 0.15,
    hasTechnologies: 0.05,
    hasSegment: 0.05,
    hasCompetitors: 0.05,
  };

  if (brand.name != null && brand.name !== "") score += weights.hasName;
  if (brand.description != null && brand.description !== "")
    score += weights.hasDescription;
  if (brand.website != null && brand.website !== "")
    score += weights.hasWebsite;
  if (brand.country != null && brand.country !== "")
    score += weights.hasCountry;
  if (brand.yearFounded != null) score += weights.hasYearFounded;
  if (brand.bestKnownFor != null && brand.bestKnownFor !== "")
    score += weights.hasBestKnownFor;
  if (stats.productCount > 0)
    score += Math.min(
      weights.hasProducts,
      weights.hasProducts * (stats.productCount / 10),
    );
  if (stats.familyCount > 0)
    score += Math.min(
      weights.hasProductFamilies,
      weights.hasProductFamilies * (stats.familyCount / 5),
    );
  if (stats.technologyCount > 0) score += weights.hasTechnologies;
  if (stats.hasSegment) score += weights.hasSegment;
  if (stats.hasCompetitors) score += weights.hasCompetitors;

  return Math.round(score * 100) / 100;
}

export function gearItemCompleteness(item: Record<string, unknown>): number {
  let score = 0;
  const weights = {
    hasName: 0.1,
    hasBrand: 0.1,
    hasDescription: 0.15,
    hasCategory: 0.1,
    hasWeight: 0.15,
    hasPrice: 0.1,
    hasFeatures: 0.1,
    hasGearId: 0.05,
    hasSourceUrl: 0.05,
    hasYear: 0.05,
    hasImageUrl: 0.05,
  };

  if (item.name != null && item.name !== "") score += weights.hasName;
  if (item.brand != null && item.brand !== "") score += weights.hasBrand;
  if (item.description != null && item.description !== "")
    score += weights.hasDescription;
  if (item.category != null && item.category !== "")
    score += weights.hasCategory;
  if (item.weight_grams != null || item.weightGrams != null)
    score += weights.hasWeight;
  if (item.price_usd != null || item.price_eur != null)
    score += weights.hasPrice;
  if (
    item.features != null &&
    Array.isArray(item.features) &&
    item.features.length > 0
  )
    score += weights.hasFeatures;
  if (item.gearId != null && item.gearId !== "") score += weights.hasGearId;
  if (item.sourceUrl != null && item.sourceUrl !== "")
    score += weights.hasSourceUrl;
  if (item.year != null) score += weights.hasYear;
  if (item.imageUrl != null && item.imageUrl !== "")
    score += weights.hasImageUrl;

  return Math.round(score * 100) / 100;
}
