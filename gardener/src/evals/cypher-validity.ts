import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getReadSession, verifyConnection, closeDriver } from "../lib/memgraph.js";

/**
 * Cypher Validity Eval
 *
 * Tests that generated Cypher queries are syntactically valid
 * by running EXPLAIN on them before execution.
 * Target: 100% validity (syntax errors = hard failures)
 */

beforeAll(async () => {
  const ok = await verifyConnection();
  if (!ok) {
    console.warn("Memgraph is not reachable — skipping Cypher Validity tests");
    return "skip";
  }
});

afterAll(async () => {
  await closeDriver();
});

const SAMPLE_QUERIES = [
  // Brand assessment queries
  {
    name: "Get brand with properties",
    query:
      'MATCH (b:OutdoorBrand {name: $name}) RETURN b',
    params: { name: "MSR" },
  },
  {
    name: "Count products per brand",
    query:
      "MATCH (g:GearItem {brand: $brand}) RETURN count(g) AS productCount",
    params: { brand: "MSR" },
  },
  {
    name: "Find brands without products",
    query:
      "MATCH (b:OutdoorBrand) WHERE NOT (b)<-[:PRODUCED_BY]-() RETURN b.name LIMIT 10",
    params: {},
  },
  // Product discovery queries
  {
    name: "Find product families for brand",
    query:
      "MATCH (b:OutdoorBrand {name: $name})-[:MANUFACTURES]->(f:ProductFamily) RETURN f.name",
    params: { name: "MSR" },
  },
  // MERGE queries
  {
    name: "MERGE brand with SET",
    query:
      'MERGE (b:OutdoorBrand {name: $name}) SET b.website = $website, b.updatedAt = datetime()',
    params: { name: "TestBrand", website: "https://example.com" },
  },
  // Relationship queries
  {
    name: "MERGE relationship between items",
    query: `MATCH (g1:GearItem {gearId: $source}), (g2:GearItem {gearId: $target})
            MERGE (g1)-[:ALTERNATIVE_TO {createdAt: datetime()}]->(g2)`,
    params: { source: "test_item-1", target: "test_item-2" },
  },
  // Quality audit queries
  {
    name: "Find items without weight",
    query:
      "MATCH (g:GearItem) WHERE g.weight_grams IS NULL RETURN count(g) AS count",
    params: {},
  },
  {
    name: "Find duplicate names per brand",
    query: `MATCH (g1:GearItem), (g2:GearItem)
            WHERE g1.brand = g2.brand AND g1.name = g2.name AND id(g1) < id(g2)
            RETURN g1.brand, g1.name, count(*) AS dupes LIMIT 10`,
    params: {},
  },
];

describe("Cypher Validity", () => {
  it.each(SAMPLE_QUERIES)(
    "should generate valid Cypher: $name",
    async ({ query, params }) => {
      const session = getReadSession();
      try {
        // EXPLAIN validates syntax without executing
        const explainQuery = `EXPLAIN ${query}`;
        await expect(
          session.run(explainQuery, params),
        ).resolves.toBeDefined();
      } finally {
        await session.close();
      }
    },
  );
});
