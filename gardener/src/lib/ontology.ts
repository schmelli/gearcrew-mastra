export const ONTOLOGY = {
  nodeLabels: [
    "OutdoorBrand", // 762 nodes
    "GearItem", // 4353 nodes
    "ProductFamily", // 535 nodes
    "ProductType", // 130 nodes
    "Technology", // 46 nodes
    "Insight", // 3210 nodes
    "Opinion", // 757 nodes
    "VideoSource", // 707 nodes
    "DataSource", // 58 nodes
    "FeedbackPattern", // 437 nodes
    "PerformanceContext", // 138 nodes
    "UsageScenario", // 220 nodes
    "UsageContext", // 191 nodes
    "TemperatureRange", // 122 nodes
    "WeatherCondition", // 83 nodes
    "GlossaryTerm", // 356 nodes
    "PricePoint", // 39 nodes
    "FieldSource", // 182 nodes
    "MarketSegment", // 11 nodes
    "PendingReview", // Admin review queue for low-confidence data
    "ActivitySession", // Tracks a single Gardener work session
    "PropertyChange", // Audit log entry for a single property modification
  ],

  relationships: [
    // Brand relationships
    {
      type: "MANUFACTURES",
      startLabel: "OutdoorBrand",
      endLabel: "ProductFamily",
    },
    {
      type: "MANUFACTURES_ITEM",
      startLabel: "OutdoorBrand",
      endLabel: "GearItem",
    },
    {
      type: "DEVELOPS_TECHNOLOGY",
      startLabel: "OutdoorBrand",
      endLabel: "Technology",
    },
    {
      type: "BELONGS_TO_SEGMENT",
      startLabel: "OutdoorBrand",
      endLabel: "MarketSegment",
    },
    {
      type: "COMPETES_WITH",
      startLabel: "OutdoorBrand",
      endLabel: "OutdoorBrand",
    },
    {
      type: "DISTRIBUTES",
      startLabel: "OutdoorBrand",
      endLabel: "OutdoorBrand",
    },

    // Product relationships
    { type: "PRODUCED_BY", startLabel: "GearItem", endLabel: "OutdoorBrand" },
    { type: "IS_TYPE", startLabel: "GearItem", endLabel: "ProductType" },
    {
      type: "IS_VARIANT_OF",
      startLabel: "GearItem",
      endLabel: "ProductFamily",
    },
    { type: "VARIANT_OF", startLabel: "GearItem", endLabel: "ProductFamily" },
    { type: "HAS_VARIANT", startLabel: "ProductFamily", endLabel: "GearItem" },
    { type: "USES_TECHNOLOGY", startLabel: "GearItem", endLabel: "Technology" },

    // Comparison & compatibility
    { type: "COMPARE_TO", startLabel: "GearItem", endLabel: "GearItem" },
    { type: "ALTERNATIVE_TO", startLabel: "GearItem", endLabel: "GearItem" },
    { type: "PAIRS_WITH", startLabel: "GearItem", endLabel: "GearItem" },
    { type: "UPGRADE_PATH", startLabel: "GearItem", endLabel: "GearItem" },
    { type: "CARRIES", startLabel: "GearItem", endLabel: "GearItem" },
    { type: "REQUIRES", startLabel: "GearItem", endLabel: "GearItem" },
    { type: "ENHANCES", startLabel: "GearItem", endLabel: "GearItem" },
    {
      type: "INCOMPATIBLE_WITH",
      startLabel: "GearItem",
      endLabel: "GearItem",
    },

    // Performance & context
    {
      type: "HAS_PERFORMANCE_METRICS",
      startLabel: "GearItem",
      endLabel: "PerformanceContext",
    },
    {
      type: "HAS_FEEDBACK",
      startLabel: "GearItem",
      endLabel: "FeedbackPattern",
    },
    {
      type: "HAS_TEMP_RANGE",
      startLabel: "GearItem",
      endLabel: "TemperatureRange",
    },
    {
      type: "PERFORMS_IN",
      startLabel: "GearItem",
      endLabel: "WeatherCondition",
    },
    {
      type: "SUITABLE_FOR",
      startLabel: "GearItem",
      endLabel: "UsageScenario",
    },
    { type: "SUITABLE_FOR", startLabel: "GearItem", endLabel: "UsageContext" },
    { type: "HAS_PRICE", startLabel: "GearItem", endLabel: "PricePoint" },

    // Knowledge & insights
    { type: "HAS_TIP", startLabel: "GearItem", endLabel: "Insight" },
    { type: "HAS_TIP", startLabel: "OutdoorBrand", endLabel: "Insight" },
    { type: "HAS_TIP", startLabel: "ProductFamily", endLabel: "Insight" },
    { type: "HAS_OPINION", startLabel: "GearItem", endLabel: "Opinion" },
    { type: "RELATES_TO", startLabel: "GearItem", endLabel: "GlossaryTerm" },

    // Provenance
    {
      type: "HAS_DATA_SOURCE",
      startLabel: "GearItem",
      endLabel: "DataSource",
    },
    {
      type: "HAS_DATA_SOURCE",
      startLabel: "OutdoorBrand",
      endLabel: "DataSource",
    },
    {
      type: "HAS_DATA_SOURCE",
      startLabel: "ProductFamily",
      endLabel: "DataSource",
    },
    {
      type: "HAS_DATA_SOURCE",
      startLabel: "Insight",
      endLabel: "DataSource",
    },
    {
      type: "HAS_DATA_SOURCE",
      startLabel: "FeedbackPattern",
      endLabel: "DataSource",
    },
    {
      type: "HAS_DATA_SOURCE",
      startLabel: "PerformanceContext",
      endLabel: "DataSource",
    },
    {
      type: "HAS_DATA_SOURCE",
      startLabel: "TemperatureRange",
      endLabel: "DataSource",
    },
    {
      type: "HAS_DATA_SOURCE",
      startLabel: "UsageScenario",
      endLabel: "DataSource",
    },
    {
      type: "EXTRACTED_FROM",
      startLabel: "GearItem",
      endLabel: "VideoSource",
    },
    {
      type: "HAS_FIELD_SOURCE",
      startLabel: "GearItem",
      endLabel: "FieldSource",
    },

    // ProductFamily relationships
    {
      type: "PRODUCED_BY",
      startLabel: "ProductFamily",
      endLabel: "OutdoorBrand",
    },

    // PendingReview relationships
    {
      type: "PENDING_FOR",
      startLabel: "PendingReview",
      endLabel: "GearItem",
    },
    {
      type: "PENDING_FOR",
      startLabel: "PendingReview",
      endLabel: "OutdoorBrand",
    },

    // Audit trail relationships
    {
      type: "CHANGED",
      startLabel: "ActivitySession",
      endLabel: "PropertyChange",
    },
    {
      type: "CHANGED_ON",
      startLabel: "PropertyChange",
      endLabel: "GearItem",
    },
    {
      type: "CHANGED_ON",
      startLabel: "PropertyChange",
      endLabel: "OutdoorBrand",
    },
    {
      type: "CREATED_REVIEW",
      startLabel: "ActivitySession",
      endLabel: "PendingReview",
    },
  ],

  requiredProperties: {
    GearItem: ["name", "brand"],
    OutdoorBrand: ["name"],
    ProductFamily: ["name"],
    PendingReview: ["type", "status", "confidence", "reason"],
    ActivitySession: ["sessionId", "type", "status", "startedAt"],
    PropertyChange: ["changeId", "property", "oldValue", "newValue", "confidence", "createdAt"],
  } as Record<string, string[]>,

  uniqueConstraints: {
    GearItem: ["gearId"],
    OutdoorBrand: ["name"],
    ProductFamily: ["familyId"],
    DataSource: ["name", "sourceURL"],
    UsageScenario: ["scenarioName"],
    WeatherCondition: ["name"],
    MarketSegment: ["name"],
    ProductType: ["name"],
    GlossaryTerm: ["name"],
  } as Record<string, string[]>,

  notes: `The GearGraph currently contains 762 OutdoorBrands, 4353 GearItems,
535 ProductFamilies, and 3210 Insights. Many brands have minimal data —
only a name and possibly a few products. The Gardener's primary job is to
enrich these sparse nodes into comprehensive profiles.

Key filling factor observations from the live schema:
- GearItem.weight_grams: 57% filled (target: >90%)
- GearItem.price_usd: 55% filled (target: >80%)
- GearItem.description: 83% filled (target: >95%)
- GearItem.features: 62% filled (target: >80%)
- GearItem.category: 95% filled (good)
- OutdoorBrand.description: 20% filled (target: >80%)
- OutdoorBrand.website: 17% filled (target: >90%)
- OutdoorBrand.country: 20% filled (target: >80%)
- OutdoorBrand.yearFounded: 15% filled (target: >60%)

PendingReview: Items awaiting admin review. Status: pending/approved/rejected. Created by Gardener when confidence < 50%. Linked to target node via PENDING_FOR relationship.

ActivitySession: Tracks a single Gardener work session (video import, enrichment run, audit). Status: running/completed/failed. Every write operation must be linked to a session.

PropertyChange: Audit log entry for a single property modification. Links to the target node via CHANGED_ON and to the session via CHANGED. Stores oldValue, newValue, confidence, sources, and reasoning for full provenance.`,
};

export type OntologyType = typeof ONTOLOGY;
