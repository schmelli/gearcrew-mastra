import { describe, it, expect } from "vitest";
import { getSession } from "../lib/memgraph";

/**
 * No Duplicate Creation Eval
 *
 * Tests that the Gardener does not create duplicate nodes.
 * Method: After a batch run, query for nodes with same name+brand.
 * Target: 0 duplicates created
 */

describe("No Duplicate Creation", () => {
  it("should have no duplicate GearItems (same name + brand)", async () => {
    const session = getSession();
    try {
      const result = await session.run(`
        MATCH (g1:GearItem), (g2:GearItem)
        WHERE g1.brand = g2.brand
          AND g1.name = g2.name
          AND id(g1) < id(g2)
        RETURN g1.brand AS brand, g1.name AS name, count(*) AS duplicates
        LIMIT 20
      `);

      const duplicates = result.records.map((r) => ({
        brand: r.get("brand"),
        name: r.get("name"),
        count: r.get("duplicates").toNumber(),
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
    const session = getSession();
    try {
      const result = await session.run(`
        MATCH (b1:OutdoorBrand), (b2:OutdoorBrand)
        WHERE b1.name = b2.name
          AND id(b1) < id(b2)
        RETURN b1.name AS name, count(*) AS duplicates
        LIMIT 20
      `);

      const duplicates = result.records.map((r) => ({
        name: r.get("name"),
        count: r.get("duplicates").toNumber(),
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
    const session = getSession();
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
        count: r.get("cnt").toNumber(),
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
