import { describe, it, expect } from "vitest";
import { ONTOLOGY } from "../lib/ontology.js";

/**
 * Ontology Compliance Eval
 *
 * Tests that all relationship types and node labels used in queries
 * are valid according to the ONTOLOGY definition.
 * Target: 100% compliance
 */

function extractLabels(cypher: string): string[] {
  // Match the primary label after (var: or (:
  const primaryPattern = /\((?:\w+)?:(\w+)/g;
  const labels: string[] = [];
  let match;
  while ((match = primaryPattern.exec(cypher)) !== null) {
    labels.push(match[1]);

    // Check for additional labels on the same node, e.g. (n:Label1:Label2)
    const afterPrimary = cypher.slice(match.index + match[0].length);
    const multiLabelPattern = /^:(\w+)/g;
    let extraMatch;
    while ((extraMatch = multiLabelPattern.exec(afterPrimary)) !== null) {
      labels.push(extraMatch[1]);
    }
  }
  return labels;
}

function extractRelationshipTypes(cypher: string): string[] {
  // Match relationship types including pipe-delimited like [:TYPE1|TYPE2]
  const relPattern = /\[:(\w+(?:\|\w+)*)/g;
  const types: string[] = [];
  let match;
  while ((match = relPattern.exec(cypher)) !== null) {
    const raw = match[1];
    // Split on pipe to handle [:TYPE1|TYPE2]
    for (const t of raw.split("|")) {
      types.push(t);
    }
  }
  return types;
}

const SAMPLE_CYPHER_QUERIES = [
  'MATCH (b:OutdoorBrand {name: $name}) RETURN b',
  "MATCH (g:GearItem {brand: $brand})-[:PRODUCED_BY]->(b:OutdoorBrand) RETURN g, b",
  "MATCH (g:GearItem)-[:USES_TECHNOLOGY]->(t:Technology) RETURN g.name, t.name",
  "MATCH (g1:GearItem)-[:ALTERNATIVE_TO]->(g2:GearItem) RETURN g1.name, g2.name",
  "MATCH (g:GearItem)-[:PAIRS_WITH]->(g2:GearItem) RETURN g.name, g2.name",
  "MATCH (b:OutdoorBrand)-[:MANUFACTURES]->(f:ProductFamily) RETURN b.name, f.name",
  "MATCH (g:GearItem)-[:IS_VARIANT_OF]->(f:ProductFamily) RETURN g.name, f.name",
  "MATCH (b:OutdoorBrand)-[:BELONGS_TO_SEGMENT]->(s:MarketSegment) RETURN b.name, s.name",
  "MATCH (g:GearItem)-[:HAS_TIP]->(i:Insight) RETURN g.name, i",
  "MATCH (g:GearItem)-[:SUITABLE_FOR]->(u:UsageScenario) RETURN g.name, u.scenarioName",
  "MATCH (g:GearItem)-[:HAS_DATA_SOURCE]->(d:DataSource) RETURN g.name, d.name",
  "MATCH (g:GearItem)-[:HAS_PRICE]->(p:PricePoint) RETURN g.name, p",
];

describe("Ontology Compliance", () => {
  describe("Node Labels", () => {
    it.each(SAMPLE_CYPHER_QUERIES)(
      "should only use valid node labels in: %s",
      (query) => {
        const labels = extractLabels(query);
        for (const label of labels) {
          expect(
            ONTOLOGY.nodeLabels,
            `Unknown label '${label}' in query: ${query}`,
          ).toContain(label);
        }
      },
    );

    it("should detect invalid node labels", () => {
      const badQuery =
        "MATCH (x:FakeLabel)-[:PRODUCED_BY]->(b:OutdoorBrand) RETURN x";
      const labels = extractLabels(badQuery);
      const invalidLabels = labels.filter(
        (l) => !ONTOLOGY.nodeLabels.includes(l),
      );
      expect(
        invalidLabels.length,
        "Expected to find at least one invalid label",
      ).toBeGreaterThan(0);
      expect(invalidLabels).toContain("FakeLabel");
    });
  });

  describe("Relationship Types", () => {
    it.each(SAMPLE_CYPHER_QUERIES)(
      "should only use valid relationship types in: %s",
      (query) => {
        const types = extractRelationshipTypes(query);
        const validTypes = ONTOLOGY.relationships.map((r) => r.type);
        for (const type of types) {
          expect(
            validTypes,
            `Unknown relationship type '${type}' in query: ${query}`,
          ).toContain(type);
        }
      },
    );
  });

  describe("Required Properties", () => {
    it("should define required properties for GearItem", () => {
      expect(ONTOLOGY.requiredProperties.GearItem).toContain("name");
      expect(ONTOLOGY.requiredProperties.GearItem).toContain("brand");
    });

    it("should define required properties for OutdoorBrand", () => {
      expect(ONTOLOGY.requiredProperties.OutdoorBrand).toContain("name");
    });

    it("should define required properties for ProductFamily", () => {
      expect(ONTOLOGY.requiredProperties.ProductFamily).toContain("name");
    });
  });

  describe("Unique Constraints", () => {
    it("should define unique constraint on GearItem.gearId", () => {
      expect(ONTOLOGY.uniqueConstraints.GearItem).toContain("gearId");
    });

    it("should define unique constraint on OutdoorBrand.name", () => {
      expect(ONTOLOGY.uniqueConstraints.OutdoorBrand).toContain("name");
    });
  });
});
