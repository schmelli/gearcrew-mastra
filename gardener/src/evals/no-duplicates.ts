import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getReadSession, verifyConnection, closeDriver, toNumber } from "../lib/memgraph.js";

/**
 * No Duplicate Creation Eval
 *
 * Tests that the Gardener does not create duplicate nodes.
 * Method: After a batch run, query for nodes with same name+brand.
 * Target: 0 duplicates created
 */

beforeAll(async () => {
  const ok = await verifyConnection();
  if (!ok) {
    console.warn("Memgraph is not reachable — skipping No Duplicate Creation tests");
    return "skip";
  }
});

afterAll(async () => {
  await closeDriver();
});

describe("No Duplicate Creation", () => {
  it("should have no duplicate GearItems (same name + brand)", async () => {
    const session = getReadSession();
    try {
      const result = await session.run(`
        MATCH (g:GearItem)
        WITH g.brand AS brand, g.name AS name, count(*) AS cnt
        WHERE cnt > 1
        RETURN brand, name, cnt
        LIMIT 20
      `);

      const duplicates = result.records.map((r) => ({
        brand: r.get("brand"),
        name: r.get("name"),
        count: toNumber(r.get("cnt")),
      }));

      if (duplicates.length > 0) {
        console.warn(
          "Duplicate GearItems found:",
          JSON.stringify(duplicates, null, 2),
        );
      }

      expect(
        duplicates.length,
        `Found ${duplicates.length} duplicate GearItem groups`,
      ).toBe(0);
    } finally {
      await session.close();
    }
  });

  it("should have no duplicate OutdoorBrands (same name)", async () => {
    const session = getReadSession();
    try {
      const result = await session.run(`
        MATCH (b:OutdoorBrand)
        WITH b.name AS name, count(*) AS cnt
        WHERE cnt > 1
        RETURN name, cnt
        LIMIT 20
      `);

      const duplicates = result.records.map((r) => ({
        name: r.get("name"),
        count: toNumber(r.get("cnt")),
      }));

      if (duplicates.length > 0) {
        console.warn(
          "Duplicate OutdoorBrands found:",
          JSON.stringify(duplicates, null, 2),
        );
      }

      expect(
        duplicates.length,
        `Found ${duplicates.length} duplicate OutdoorBrand groups`,
      ).toBe(0);
    } finally {
      await session.close();
    }
  });

  it("should have no duplicate GearItems by gearId", async () => {
    const session = getReadSession();
    try {
      const result = await session.run(`
        MATCH (g:GearItem)
        WHERE g.gearId IS NOT NULL
        WITH g.gearId AS gearId, count(*) AS cnt
        WHERE cnt > 1
        RETURN gearId, cnt
        LIMIT 20
      `);

      const duplicates = result.records.map((r) => ({
        gearId: r.get("gearId"),
        count: toNumber(r.get("cnt")),
      }));

      expect(
        duplicates.length,
        `Found ${duplicates.length} duplicate gearIds`,
      ).toBe(0);
    } finally {
      await session.close();
    }
  });
});
