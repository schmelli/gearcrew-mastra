export interface BrandStats {
  productCount: number;
  familyCount: number;
  technologyCount: number;
}

export function brandCompleteness(
  brand: Record<string, any>,
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

  if (brand.name) score += weights.hasName;
  if (brand.description) score += weights.hasDescription;
  if (brand.website) score += weights.hasWebsite;
  if (brand.country) score += weights.hasCountry;
  if (brand.yearFounded) score += weights.hasYearFounded;
  if (brand.bestKnownFor) score += weights.hasBestKnownFor;
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

  return Math.round(score * 100) / 100;
}

export function gearItemCompleteness(item: Record<string, any>): number {
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

  if (item.name) score += weights.hasName;
  if (item.brand) score += weights.hasBrand;
  if (item.description) score += weights.hasDescription;
  if (item.category) score += weights.hasCategory;
  if (item.weight_grams || item.weightGrams) score += weights.hasWeight;
  if (item.price_usd || item.price_eur) score += weights.hasPrice;
  if (item.features) score += weights.hasFeatures;
  if (item.gearId) score += weights.hasGearId;
  if (item.sourceUrl) score += weights.hasSourceUrl;
  if (item.year) score += weights.hasYear;
  if (item.imageUrl) score += weights.hasImageUrl;

  return Math.round(score * 100) / 100;
}
