/**
 * Brand-Category Scan Workflow
 * Phase 2: Autonomous brand-by-brand, category-by-category graph maintenance.
 *
 * Each tick processes ONE brand+category combination:
 *   1. Pick next target (least-recently-audited brand/category)
 *   2. Load current graph state for that combination
 *   3. Let the agent research & update the graph
 *   4. Mark brand/category as audited
 *   5. Write a CycleReport node
 */

import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { randomUUID } from "crypto";
import { getReadSession, getWriteSession, toNumber } from "../lib/memgraph.js";
import { MAX_STEPS, SONNET_MAX_STEPS } from "../agents/gardener-v3.js";

// ---------------------------------------------------------------------------
// Top brands — prioritized for scanning (well-known outdoor gear companies)
// ---------------------------------------------------------------------------

const TOP_BRANDS = new Set([
  // Shelter & Tents
  "MSR", "Big Agnes", "Hilleberg", "NEMO Equipment", "Zpacks", "Tarptent",
  "Hyperlite Mountain Gear", "Six Moon Designs", "Sea to Summit", "Nordisk",
  // Backpacks
  "Osprey", "Gregory", "Deuter", "Arc'teryx", "ULA Equipment", "Granite Gear",
  "Gossamer Gear", "Mountain Laurel Designs", "Pa'lante Packs",
  // Sleeping
  "Western Mountaineering", "Enlightened Equipment", "Thermarest",
  "Feathered Friends", "Rab", "Mountain Hardwear", "Exped",
  // Clothing
  "Patagonia", "The North Face", "Fjällräven", "Montane", "Haglöfs",
  "Mammut", "Salomon", "Black Diamond", "Outdoor Research",
  // Cooking & Water
  "Jetboil", "Sawyer", "Katadyn", "Platypus", "BRS",
  // Electronics
  "Garmin", "Petzl", "Black Diamond", "BioLite", "Nitecore", "Goal Zero",
  // Footwear
  "Hoka", "Altra", "La Sportiva", "Scarpa", "Merrell",
  // Trekking Poles & Misc
  "Leki", "Helinox", "Leatherman", "Victorinox",
]);

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const triggerSchema = z.object({
  brandName: z
    .string()
    .optional()
    .describe("Specific brand name to scan (optional — if empty, picks next from queue)"),
  categoryName: z
    .string()
    .optional()
    .describe("Specific category name to scan (optional — if empty, picks next for brand)"),
});

const targetOutputSchema = z.object({
  brandName: z.string().optional(),
  brandSlug: z.string().optional(),
  brandWebsite: z.string().optional(),
  categoryName: z.string().optional(),
  categorySlug: z.string().optional(),
  skipped: z.boolean(),
  reason: z.string().optional(),
  cycleId: z.string(),
  startedAt: z.string(),
});

const graphStateOutputSchema = z.object({
  brandName: z.string(),
  brandWebsite: z.string().optional(),
  categoryName: z.string(),
  products: z.array(
    z.object({
      name: z.string(),
      gearId: z.string().optional(),
      weight: z.number().nullable().optional(),
      price: z.number().nullable().optional(),
      description: z.string().nullable().optional(),
      productUrl: z.string().nullable().optional(),
      discontinued: z.boolean().nullable().optional(),
      lastVerified: z.string().nullable().optional(),
    }),
  ),
  productCount: z.number(),
  cycleId: z.string(),
  startedAt: z.string(),
  skipped: z.boolean(),
});

const scanOutputSchema = z.object({
  agentResponse: z.string(),
  toolCallCount: z.number(),
  brandName: z.string(),
  categoryName: z.string(),
  cycleId: z.string(),
  startedAt: z.string(),
  skipped: z.boolean(),
  error: z.boolean(),
  // Detailed report fields (parsed from agent response)
  productsChecked: z.number(),
  productsAdded: z.number(),
  productsUpdated: z.number(),
  successorsFound: z.number(),
  discontinuedMarked: z.number(),
  specsFilled: z.number(),
  changes: z.array(z.string()),
});

const auditOutputSchema = z.object({
  brandName: z.string(),
  categoryName: z.string(),
  brandFullyAudited: z.boolean(),
  cycleId: z.string(),
  startedAt: z.string(),
  toolCallCount: z.number(),
  skipped: z.boolean(),
  error: z.boolean(),
  productsChecked: z.number(),
  productsAdded: z.number(),
  productsUpdated: z.number(),
  successorsFound: z.number(),
  discontinuedMarked: z.number(),
  specsFilled: z.number(),
  changes: z.array(z.string()),
});

const reportOutputSchema = z.object({
  cycleId: z.string(),
  outcome: z.string(),
  brandName: z.string().optional(),
  categoryName: z.string().optional(),
  toolCallCount: z.number(),
  productsChecked: z.number(),
  productsAdded: z.number(),
  productsUpdated: z.number(),
  successorsFound: z.number(),
  discontinuedMarked: z.number(),
  specsFilled: z.number(),
  changes: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// Step 1: pick-next-target
// ---------------------------------------------------------------------------

const pickNextTarget = createStep({
  id: "pick-next-target",
  description: "Select the next brand+category to scan (least-recently-audited first)",
  inputSchema: triggerSchema,
  outputSchema: targetOutputSchema,
  execute: async ({ inputData }) => {
    const cycleId = randomUUID();
    const startedAt = new Date().toISOString();

    let brandName: string | undefined;
    let brandSlug: string | undefined;
    let brandWebsite: string | undefined;

    const session = getReadSession();
    try {
      // --- Resolve brand ---
      if (inputData.brandName) {
        const res = await session.run(
          `MATCH (b:OutdoorBrand {name: $name})
           RETURN b.name AS brandName, b.slug AS brandSlug, b.website AS brandWebsite`,
          { name: inputData.brandName },
        );
        if (res.records.length > 0) {
          const rec = res.records[0]!;
          brandName = rec.get("brandName") as string;
          brandSlug = rec.get("brandSlug") as string;
          brandWebsite = (rec.get("brandWebsite") as string) ?? undefined;
        }
      } else {
        // Priority scoring:
        // 1. Never-audited brands first (auditScore 0 vs 1)
        // 2. Top brands get priority boost (topScore 0 vs 1)
        // 3. More missing specs = higher priority (missingSpecs DESC)
        // 4. Among audited brands: oldest audit first
        const res = await session.run(
          `MATCH (b:OutdoorBrand)-[:MANUFACTURES_ITEM]->(g:GearItem)
           WITH b, count(g) AS productCount,
                sum(CASE WHEN g.weight_grams IS NULL THEN 1 ELSE 0 END) +
                sum(CASE WHEN g.price_usd IS NULL THEN 1 ELSE 0 END) +
                sum(CASE WHEN g.description IS NULL THEN 1 ELSE 0 END) +
                sum(CASE WHEN g.productUrl IS NULL THEN 1 ELSE 0 END) AS missingSpecs
           ORDER BY
             CASE WHEN b.last_audited_at IS NULL THEN 0 ELSE 1 END,
             CASE WHEN b.name IN $topBrands THEN 0 ELSE 1 END,
             missingSpecs DESC,
             b.last_audited_at ASC
           LIMIT 1
           RETURN b.name AS brandName, b.slug AS brandSlug, b.website AS brandWebsite,
                  b.last_audited_at AS lastAuditedAt, productCount`,
          { topBrands: [...TOP_BRANDS] },
        );
        if (res.records.length > 0) {
          const rec = res.records[0]!;
          brandName = rec.get("brandName") as string;
          brandSlug = rec.get("brandSlug") as string;
          brandWebsite = (rec.get("brandWebsite") as string) ?? undefined;
        }
      }

      if (!brandName) {
        return {
          skipped: true,
          reason: "No brands to scan",
          cycleId,
          startedAt,
        };
      }

      // --- Count total products for this brand ---
      const SMALL_BRAND_THRESHOLD = 20;
      let categoryName: string | undefined;
      let categorySlug: string | undefined;

      const countRes = await session.run(
        `MATCH (b:OutdoorBrand {name: $brandName})-[:MANUFACTURES_ITEM]->(g:GearItem)
         RETURN count(g) AS totalProducts`,
        { brandName },
      );
      const totalProducts = toNumber(countRes.records[0]?.get("totalProducts"));

      if (inputData.categoryName) {
        // Explicit category requested
        if (inputData.categoryName === "__all__" || inputData.categoryName === "__classify__") {
          categoryName = inputData.categoryName;
        } else {
          const res = await session.run(
            `MATCH (pt:ProductType {name: $name})
             RETURN pt.name AS categoryName, pt.slug AS categorySlug`,
            { name: inputData.categoryName },
          );
          if (res.records.length > 0) {
            const rec = res.records[0]!;
            categoryName = rec.get("categoryName") as string;
            categorySlug = rec.get("categorySlug") as string;
          }
        }
      } else if (totalProducts <= SMALL_BRAND_THRESHOLD) {
        // Small brand (≤20 products) → scan ALL products at once, no category split
        console.log(
          `[pick-next-target] ${brandName}: ${totalProducts} products (small brand) → full scan`,
        );
        categoryName = "__all__";
      } else {
        // Large brand (>20 products) → find next un-audited category
        const res = await session.run(
          `MATCH (b:OutdoorBrand {name: $brandName})-[:MANUFACTURES_ITEM]->(g:GearItem)-[:IS_TYPE]->(pt:ProductType)
           WITH DISTINCT pt, b
           OPTIONAL MATCH (b)-[audit:AUDITED_CATEGORY]->(pt)
           WITH pt, audit
           ORDER BY CASE WHEN audit.at IS NULL THEN 0 ELSE 1 END, audit.at ASC
           LIMIT 1
           RETURN pt.name AS categoryName, pt.slug AS categorySlug`,
          { brandName },
        );
        if (res.records.length > 0) {
          const rec = res.records[0]!;
          categoryName = rec.get("categoryName") as string;
          categorySlug = rec.get("categorySlug") as string;
        }

        if (!categoryName) {
          // Large brand with no categories — check for unclassified products
          const unclassifiedRes = await session.run(
            `MATCH (b:OutdoorBrand {name: $brandName})-[:MANUFACTURES_ITEM]->(g:GearItem)
             WHERE NOT (g)-[:IS_TYPE]->(:ProductType)
             RETURN count(g) AS unclassifiedCount`,
            { brandName },
          );
          const unclassifiedCount = toNumber(
            unclassifiedRes.records[0]?.get("unclassifiedCount"),
          );

          if (unclassifiedCount > 0) {
            console.log(
              `[pick-next-target] ${brandName}: ${unclassifiedCount} unclassified products (large brand) → classify mode`,
            );
            categoryName = "__classify__";
          } else {
            // All categories audited — mark brand as fully audited
            const writeSession = getWriteSession();
            try {
              await writeSession.run(
                `MATCH (b:OutdoorBrand {name: $brandName})
                 SET b.last_audited_at = datetime()`,
                { brandName },
              );
            } finally {
              await writeSession.close();
            }
            return {
              brandName,
              brandSlug,
              brandWebsite,
              skipped: true,
              reason: "Brand fully audited",
              cycleId,
              startedAt,
            };
          }
        }
      }

      if (!categoryName) {
        return { skipped: true, reason: "No category resolved", cycleId, startedAt };
      }

      const modeLabel = categoryName === "__all__" ? "ALL" : categoryName === "__classify__" ? "CLASSIFY" : categoryName;
      console.log(`[pick-next-target] Selected: ${brandName} / ${modeLabel} (${totalProducts} products)`);

      return {
        brandName,
        brandSlug,
        brandWebsite,
        categoryName,
        categorySlug,
        skipped: false,
        cycleId,
        startedAt,
      };
    } finally {
      await session.close();
    }
  },
});

// ---------------------------------------------------------------------------
// Step 2: load-graph-state
// ---------------------------------------------------------------------------

const loadGraphState = createStep({
  id: "load-graph-state",
  description: "Load existing products for the target brand+category from the graph",
  inputSchema: targetOutputSchema,
  outputSchema: graphStateOutputSchema,
  execute: async ({ inputData }) => {
    if (inputData.skipped) {
      return {
        brandName: inputData.brandName ?? "",
        brandWebsite: inputData.brandWebsite,
        categoryName: inputData.categoryName ?? "",
        products: [],
        productCount: 0,
        cycleId: inputData.cycleId,
        startedAt: inputData.startedAt,
        skipped: true,
      };
    }

    const isClassifyMode = inputData.categoryName === "__classify__";
    const isAllMode = inputData.categoryName === "__all__";
    const session = getReadSession();
    try {
      // __all__: load ALL products for this brand (small brands ≤20 products)
      // __classify__: load unclassified products (max 50)
      // normal: load products for this brand+category
      const query = isAllMode
        ? `MATCH (b:OutdoorBrand {name: $brandName})-[:MANUFACTURES_ITEM]->(g:GearItem)
           RETURN g.name AS name, g.gearId AS gearId, g.weight_grams AS weight,
                  g.price_usd AS price, g.description AS description, g.productUrl AS productUrl,
                  g.discontinued AS discontinued, g.last_verified_at AS lastVerified
           ORDER BY g.name`
        : isClassifyMode
          ? `MATCH (b:OutdoorBrand {name: $brandName})-[:MANUFACTURES_ITEM]->(g:GearItem)
             WHERE NOT (g)-[:IS_TYPE]->(:ProductType)
             RETURN g.name AS name, g.gearId AS gearId, g.weight_grams AS weight,
                    g.price_usd AS price, g.description AS description, g.productUrl AS productUrl,
                    g.discontinued AS discontinued, g.last_verified_at AS lastVerified
             ORDER BY g.name
             LIMIT 50`
          : `MATCH (b:OutdoorBrand {name: $brandName})-[:MANUFACTURES_ITEM]->(g:GearItem)-[:IS_TYPE]->(pt:ProductType {name: $categoryName})
             RETURN g.name AS name, g.gearId AS gearId, g.weight_grams AS weight,
                    g.price_usd AS price, g.description AS description, g.productUrl AS productUrl,
                    g.discontinued AS discontinued, g.last_verified_at AS lastVerified
             ORDER BY g.name`;

      const res = await session.run(query, {
        brandName: inputData.brandName,
        categoryName: inputData.categoryName,
      });

      const products = res.records.map((rec) => ({
        name: rec.get("name") as string,
        gearId: (rec.get("gearId") as string) ?? undefined,
        weight: toNumber(rec.get("weight")) || null,
        price: toNumber(rec.get("price")) || null,
        description: (rec.get("description") as string) ?? null,
        productUrl: (rec.get("productUrl") as string) ?? null,
        discontinued: (rec.get("discontinued") as boolean) ?? null,
        lastVerified: rec.get("lastVerified")?.toString() ?? null,
      }));

      return {
        brandName: inputData.brandName!,
        brandWebsite: inputData.brandWebsite,
        categoryName: inputData.categoryName!,
        products,
        productCount: products.length,
        cycleId: inputData.cycleId,
        startedAt: inputData.startedAt,
        skipped: false,
      };
    } finally {
      await session.close();
    }
  },
});

// ---------------------------------------------------------------------------
// Report parser — extracts structured data from agent's JSON response
// ---------------------------------------------------------------------------

interface ParsedReport {
  productsChecked: number;
  productsAdded: number;
  productsUpdated: number;
  successorsFound: number;
  discontinuedMarked: number;
  specsFilled: number;
  changes: string[];
}

const EMPTY_REPORT: ParsedReport = {
  productsChecked: 0,
  productsAdded: 0,
  productsUpdated: 0,
  successorsFound: 0,
  discontinuedMarked: 0,
  specsFilled: 0,
  changes: [],
};

function parseAgentReport(text: string): ParsedReport {
  // Extract JSON from markdown code fence
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (!fenceMatch) return EMPTY_REPORT;

  try {
    const parsed = JSON.parse(fenceMatch[1].trim()) as Record<string, unknown>;
    return {
      productsChecked: Number(parsed.productsChecked ?? 0),
      productsAdded: Number(parsed.productsAdded ?? 0),
      productsUpdated: Number(parsed.productsUpdated ?? 0),
      successorsFound: Number(parsed.successorsFound ?? 0),
      discontinuedMarked: Number(parsed.discontinuedMarked ?? 0),
      specsFilled: Number(parsed.specsFilled ?? 0),
      changes: Array.isArray(parsed.changes)
        ? (parsed.changes as unknown[]).map(String).slice(0, 50)
        : [],
    };
  } catch {
    console.warn("[parseAgentReport] Failed to parse JSON from agent response");
    return EMPTY_REPORT;
  }
}

// ---------------------------------------------------------------------------
// Step 3: scan-category (agent call)
// ---------------------------------------------------------------------------

const scanCategory = createStep({
  id: "scan-category",
  description: "Let the GardenerV3 agent research and update the category",
  inputSchema: graphStateOutputSchema,
  outputSchema: scanOutputSchema,
  execute: async ({ inputData, mastra }) => {
    const emptyReport = { ...EMPTY_REPORT };

    if (inputData.skipped) {
      return {
        agentResponse: "Skipped — no target to scan.",
        toolCallCount: 0,
        brandName: inputData.brandName,
        categoryName: inputData.categoryName,
        cycleId: inputData.cycleId,
        startedAt: inputData.startedAt,
        skipped: true,
        error: false,
        ...emptyReport,
      };
    }

    if (!mastra) throw new Error("Mastra context is required");
    const haikuAgent = mastra.getAgent("GardenerHaiku");
    const sonnetAgent = mastra.getAgent("GardenerSonnet");
    const isClassifyMode = inputData.categoryName === "__classify__";
    const isAllMode = inputData.categoryName === "__all__";

    const productList =
      inputData.products.length > 0
        ? inputData.products
            .map(
              (p) =>
                `- ${p.name} (${p.gearId ?? "NO_ID"}) | Gewicht: ${p.weight ?? "FEHLT"} | Preis: ${p.price ?? "FEHLT"} | URL: ${p.productUrl ?? "FEHLT"}`,
            )
            .join("\n")
        : "(keine Produkte im Graph)";

    const prompt = isAllMode
      ? `Prüfe ALLE Produkte der Brand "${inputData.brandName}".

Brand-Website: ${inputData.brandWebsite || "nicht bekannt"}

Aktuell im Graph (${inputData.productCount} Produkte):
${productList}

Deine Aufgaben:
1. Recherchiere welche aktuellen Produkte ${inputData.brandName} anbietet — NICHT NUR die bestehenden!
   Suche aktiv nach weiteren Produktlinien und Kategorien dieser Brand die noch nicht im Graph sind.
   Beispiel: Wenn nur Jacken im Graph sind, aber die Brand auch Rucksäcke oder Zelte herstellt → hinzufügen!
2. Ergänze fehlende Produkte via MERGE (bis zu 15 neue Produkte pro Scan)
3. Erkenne Nachfolger-Produkte und setze SUPERSEDES/SUPERSEDED_BY-Kanten
4. Trage fehlende Spezifikationen nach (Gewicht, Preis, URL, Beschreibung)
5. Setze last_verified_at = datetime() auf alle geprüften Items

Beginne mit getOntology, dann graphQuery zum Verifizieren, dann webSearch/webScrape zum Recherchieren.
Recherchiere auf der Hersteller-Website die KOMPLETTE Produktpalette — nicht nur die bereits bekannten Produkte.

WICHTIG — Wenn du fertig bist, schreibe am Ende deiner Antwort einen strukturierten Report im folgenden EXAKTEN Format (JSON in einem Codeblock):

\`\`\`json
{
  "productsChecked": 8,
  "productsAdded": 5,
  "productsUpdated": 3,
  "successorsFound": 1,
  "discontinuedMarked": 0,
  "specsFilled": 5,
  "changes": [
    "ADDED: Product Name (gear-id) — 450g, $199",
    "UPDATED: Product Name — weight corrected, price added",
    "SUCCESSOR: New Model ersetzt Old Model"
  ]
}
\`\`\`

Jede Änderung muss als einzelne Zeile im changes-Array stehen. Prefixes: ADDED, UPDATED, SUCCESSOR, DISCONTINUED, SPECS, VERIFIED.`
      : isClassifyMode
      ? `Klassifiziere die folgenden Produkte der Brand "${inputData.brandName}" nach ProductType.

Brand-Website: ${inputData.brandWebsite || "nicht bekannt"}

Diese ${inputData.productCount} Produkte haben noch keinen ProductType (IS_TYPE-Kante):
${productList}

Deine Aufgabe:
1. Lade zuerst die Ontologie (getOntology) um die existierenden ProductTypes zu sehen
2. Für jedes Produkt: Bestimme den passenden ProductType anhand des Namens und ggf. einer kurzen Web-Recherche
3. Schreibe die IS_TYPE-Kante via graphWrite:
   MERGE (g:GearItem {name: $name, brand: $brand})
   MERGE (pt:ProductType {name: $productType})
   MERGE (g)-[:IS_TYPE]->(pt)

Regeln:
- Verwende BESTEHENDE ProductTypes aus der Ontologie wenn möglich
- Nur wenn kein passender existiert, erstelle einen neuen (MERGE!)
- Produkttyp-Namen in Englisch, CamelCase mit Leerzeichen (z.B. "Sleeping Bag", "Trekking Poles")
- Jedes Produkt braucht genau einen ProductType

WICHTIG — Wenn du fertig bist, schreibe am Ende einen Report:

\`\`\`json
{
  "productsChecked": 15,
  "productsAdded": 0,
  "productsUpdated": 15,
  "successorsFound": 0,
  "discontinuedMarked": 0,
  "specsFilled": 0,
  "changes": [
    "CLASSIFIED: Product Name → ProductType (via IS_TYPE)",
    "CLASSIFIED: Another Product → Another Type"
  ]
}
\`\`\``
      : `Prüfe die Produktkategorie "${inputData.categoryName}" der Brand "${inputData.brandName}".

Brand-Website: ${inputData.brandWebsite || "nicht bekannt"}

Aktuell im Graph (${inputData.productCount} Produkte):
${productList}

Deine Aufgaben (NUR Recherche und Specs — KEINE Nachfolger-Erkennung!):
1. Recherchiere welche aktuellen ${inputData.categoryName}-Produkte ${inputData.brandName} anbietet
2. Ergänze fehlende Produkte via MERGE
3. Trage fehlende Spezifikationen nach (Gewicht, Preis, URL, Beschreibung)
4. Setze last_verified_at = datetime() auf alle geprüften Items

WICHTIG: Setze KEINE SUPERSEDES-Kanten und markiere NICHTS als discontinued! Das macht ein anderer Agent.

Beginne mit getOntology, dann graphQuery zum Verifizieren, dann webSearch/webScrape zum Recherchieren.

WICHTIG — Wenn du fertig bist, schreibe am Ende einen Report:

\`\`\`json
{
  "productsChecked": 12,
  "productsAdded": 2,
  "productsUpdated": 5,
  "successorsFound": 0,
  "discontinuedMarked": 0,
  "specsFilled": 8,
  "changes": [
    "ADDED: Product Name (gear-id) — 450g, $199",
    "UPDATED: Product Name — weight, price added",
    "SPECS: Product Name — weight_grams: 850 nachgetragen"
  ]
}
\`\`\`

Prefixes: ADDED, UPDATED, SPECS, VERIFIED.`;

    try {
      // --- Phase 1: Haiku researches, adds products, fills specs ---
      console.log(`[scan-category] Phase 1 (Haiku): ${inputData.brandName}/${inputData.categoryName}`);
      const haikuResult = await haikuAgent.generate(prompt, { toolChoice: "auto", maxSteps: MAX_STEPS });
      const haikuText = haikuResult.text ?? "";
      const haikuReport = parseAgentReport(haikuText);
      const haikuSteps = haikuResult.steps?.length ?? 0;

      console.log(
        `[scan-category] Haiku done: +${haikuReport.productsAdded} added, ~${haikuReport.productsUpdated} updated, ${haikuReport.specsFilled} specs | ${haikuSteps} steps`,
      );

      // --- Phase 2: Sonnet reviews for successors (only if products were added or many exist) ---
      let sonnetReport = { ...EMPTY_REPORT };
      let sonnetSteps = 0;

      if (haikuReport.productsAdded > 0 || inputData.productCount >= 3) {
        console.log(`[scan-category] Phase 2 (Sonnet): successor review for ${inputData.brandName}/${inputData.categoryName}`);

        const sonnetPrompt = `Pruefe die Produkte der Brand "${inputData.brandName}" in der Kategorie "${inputData.categoryName}" auf Nachfolger-Beziehungen.

Haiku hat gerade ${haikuReport.productsAdded} neue Produkte hinzugefuegt und ${haikuReport.productsUpdated} aktualisiert.

Aenderungen von Haiku:
${haikuReport.changes.map(ch => "- " + ch).join("\n") || "(keine)"}

Deine Aufgaben:
1. Lade die aktuellen Produkte dieser Brand+Kategorie aus dem Graph (graphQuery)
2. Pruefe: Gibt es Nachfolger-Beziehungen? (Jahreszahlen, Versionsnummern, Namenszusaetze)
3. Setze SUPERSEDES-Kanten: (newer)-[:SUPERSEDES]->(older) — pruefe vorher ob sie schon existiert!
4. Markiere abgekuendigte Produkte: SET g.discontinued = true

Schreibe am Ende einen Report:

\`\`\`json
{
  "productsChecked": 0,
  "productsAdded": 0,
  "productsUpdated": 0,
  "successorsFound": 2,
  "discontinuedMarked": 1,
  "specsFilled": 0,
  "changes": [
    "SUCCESSOR: New Model ersetzt Old Model",
    "DISCONTINUED: Old Model (nicht mehr im aktuellen Lineup)"
  ]
}
\`\`\``;

        try {
          const sonnetResult = await sonnetAgent.generate(sonnetPrompt, { toolChoice: "auto", maxSteps: SONNET_MAX_STEPS });
          sonnetReport = parseAgentReport(sonnetResult.text ?? "");
          sonnetSteps = sonnetResult.steps?.length ?? 0;
          console.log(
            `[scan-category] Sonnet done: ${sonnetReport.successorsFound} successors, ${sonnetReport.discontinuedMarked} discontinued | ${sonnetSteps} steps`,
          );
        } catch (sonnetErr) {
          console.error("[scan-category] Sonnet review failed (non-critical):", sonnetErr);
          // Sonnet failure is non-critical — Haiku's work is already saved
        }
      } else {
        console.log(`[scan-category] Skipping Sonnet (no new products, <3 existing)`);
      }

      // --- Merge reports ---
      const mergedReport: ParsedReport = {
        productsChecked: haikuReport.productsChecked + sonnetReport.productsChecked,
        productsAdded: haikuReport.productsAdded + sonnetReport.productsAdded,
        productsUpdated: haikuReport.productsUpdated + sonnetReport.productsUpdated,
        successorsFound: haikuReport.successorsFound + sonnetReport.successorsFound,
        discontinuedMarked: haikuReport.discontinuedMarked + sonnetReport.discontinuedMarked,
        specsFilled: haikuReport.specsFilled + sonnetReport.specsFilled,
        changes: [...haikuReport.changes, ...sonnetReport.changes],
      };

      return {
        agentResponse: haikuText,
        toolCallCount: haikuSteps + sonnetSteps,
        brandName: inputData.brandName,
        categoryName: inputData.categoryName,
        cycleId: inputData.cycleId,
        startedAt: inputData.startedAt,
        skipped: false,
        error: false,
        ...mergedReport,
      };
    } catch (err) {
      console.error("[scan-category] agent.generate() failed:", err);
      return {
        agentResponse: `Error: ${err instanceof Error ? err.message : String(err)}`,
        toolCallCount: 0,
        brandName: inputData.brandName,
        categoryName: inputData.categoryName,
        cycleId: inputData.cycleId,
        startedAt: inputData.startedAt,
        skipped: false,
        error: true,
        ...emptyReport,
      };
    }
  },
});

// ---------------------------------------------------------------------------
// Step 4: mark-audited
// ---------------------------------------------------------------------------

const markAudited = createStep({
  id: "mark-audited",
  description: "Mark the category (and optionally brand) as audited in the graph",
  inputSchema: scanOutputSchema,
  outputSchema: auditOutputSchema,
  execute: async ({ inputData }) => {
    if (inputData.skipped) {
      return {
        brandName: inputData.brandName,
        categoryName: inputData.categoryName,
        brandFullyAudited: false,
        cycleId: inputData.cycleId,
        startedAt: inputData.startedAt,
        toolCallCount: inputData.toolCallCount,
        skipped: true,
        error: false,
        productsChecked: inputData.productsChecked,
        productsAdded: inputData.productsAdded,
        productsUpdated: inputData.productsUpdated,
        successorsFound: inputData.successorsFound,
        discontinuedMarked: inputData.discontinuedMarked,
        specsFilled: inputData.specsFilled,
        changes: inputData.changes,
      };
    }

    if (inputData.error) {
      // Mark error brands as audited so they don't block the queue
      // They'll be retried in the next full cycle (after all other brands)
      if (inputData.brandName) {
        const errSession = getWriteSession();
        try {
          await errSession.run(
            `MATCH (b:OutdoorBrand {name: $brandName})
             SET b.last_audited_at = datetime()`,
            { brandName: inputData.brandName },
          );
          console.log(`[mark-audited] Error brand "${inputData.brandName}" marked as audited to prevent queue blocking`);
        } finally {
          await errSession.close();
        }
      }
      return {
        brandName: inputData.brandName,
        categoryName: inputData.categoryName,
        brandFullyAudited: false,
        cycleId: inputData.cycleId,
        startedAt: inputData.startedAt,
        toolCallCount: inputData.toolCallCount,
        skipped: false,
        error: true,
        productsChecked: inputData.productsChecked,
        productsAdded: inputData.productsAdded,
        productsUpdated: inputData.productsUpdated,
        successorsFound: inputData.successorsFound,
        discontinuedMarked: inputData.discontinuedMarked,
        specsFilled: inputData.specsFilled,
        changes: inputData.changes,
      };
    }

    const isAllMode = inputData.categoryName === "__all__";
    const isClassifyMode = inputData.categoryName === "__classify__";

    const session = getWriteSession();
    try {
      let brandFullyAudited = false;

      if (isAllMode) {
        // Small brand: mark entire brand as audited (no category tracking)
        await session.run(
          `MATCH (b:OutdoorBrand {name: $brandName})
           SET b.last_audited_at = datetime()`,
          { brandName: inputData.brandName },
        );
        brandFullyAudited = true;
        console.log(`[mark-audited] Brand "${inputData.brandName}" fully audited (small brand, all-in-one scan)`);
      } else if (isClassifyMode) {
        // Classify mode: don't mark anything — products need a real scan next
        console.log(`[mark-audited] Brand "${inputData.brandName}" classified — will be scanned by category next`);
      } else {
        // Normal category scan: mark this category as audited for this brand
        await session.run(
          `MATCH (b:OutdoorBrand {name: $brandName}), (pt:ProductType {name: $categoryName})
           MERGE (b)-[audit:AUDITED_CATEGORY]->(pt)
           SET audit.at = datetime()`,
          { brandName: inputData.brandName, categoryName: inputData.categoryName },
        );

        // Check if ALL categories for this brand are now audited (within last 7 days)
        const res = await session.run(
          `MATCH (b:OutdoorBrand {name: $brandName})-[:MANUFACTURES_ITEM]->(g:GearItem)-[:IS_TYPE]->(pt:ProductType)
           WITH b, count(DISTINCT pt) AS totalCategories
           OPTIONAL MATCH (b)-[audit:AUDITED_CATEGORY]->(:ProductType)
           WHERE audit.at > datetime() - duration('P7D')
           WITH b, totalCategories, count(audit) AS auditedCategories
           WHERE auditedCategories >= totalCategories
           SET b.last_audited_at = datetime()
           RETURN b.name AS brandAudited`,
          { brandName: inputData.brandName },
        );

        brandFullyAudited = res.records.length > 0;
        if (brandFullyAudited) {
          console.log(`[mark-audited] Brand "${inputData.brandName}" fully audited (all categories within 7d)`);
        }
      }

      return {
        brandName: inputData.brandName,
        categoryName: inputData.categoryName,
        brandFullyAudited,
        cycleId: inputData.cycleId,
        startedAt: inputData.startedAt,
        toolCallCount: inputData.toolCallCount,
        skipped: false,
        error: false,
        productsChecked: inputData.productsChecked,
        productsAdded: inputData.productsAdded,
        productsUpdated: inputData.productsUpdated,
        successorsFound: inputData.successorsFound,
        discontinuedMarked: inputData.discontinuedMarked,
        specsFilled: inputData.specsFilled,
        changes: inputData.changes,
      };
    } finally {
      await session.close();
    }
  },
});

// ---------------------------------------------------------------------------
// Step 5: write-report
// ---------------------------------------------------------------------------

const writeReport = createStep({
  id: "write-report",
  description: "Write a CycleReport node to the graph for observability",
  inputSchema: auditOutputSchema,
  outputSchema: reportOutputSchema,
  execute: async ({ inputData }) => {
    const outcome = inputData.error ? "error" : inputData.skipped ? "skipped" : "completed";

    const session = getWriteSession();
    try {
      await session.run(
        `MERGE (r:CycleReport {cycleId: $cycleId})
         SET r.startedAt = datetime($startedAt),
             r.completedAt = datetime(),
             r.brandName = $brandName,
             r.categoryName = $categoryName,
             r.toolCalls = $toolCallCount,
             r.outcome = $outcome,
             r.productsChecked = $productsChecked,
             r.productsAdded = $productsAdded,
             r.productsUpdated = $productsUpdated,
             r.successorsFound = $successorsFound,
             r.discontinuedMarked = $discontinuedMarked,
             r.specsFilled = $specsFilled,
             r.changes = $changes`,
        {
          cycleId: inputData.cycleId,
          startedAt: inputData.startedAt,
          brandName: inputData.brandName,
          categoryName: inputData.categoryName,
          toolCallCount: inputData.toolCallCount,
          outcome,
          productsChecked: inputData.productsChecked,
          productsAdded: inputData.productsAdded,
          productsUpdated: inputData.productsUpdated,
          successorsFound: inputData.successorsFound,
          discontinuedMarked: inputData.discontinuedMarked,
          specsFilled: inputData.specsFilled,
          changes: inputData.changes,
        },
      );
    } finally {
      await session.close();
    }

    return {
      cycleId: inputData.cycleId,
      outcome,
      brandName: inputData.brandName,
      categoryName: inputData.categoryName,
      toolCallCount: inputData.toolCallCount,
      productsChecked: inputData.productsChecked,
      productsAdded: inputData.productsAdded,
      productsUpdated: inputData.productsUpdated,
      successorsFound: inputData.successorsFound,
      discontinuedMarked: inputData.discontinuedMarked,
      specsFilled: inputData.specsFilled,
      changes: inputData.changes,
    };
  },
});

// ---------------------------------------------------------------------------
// Workflow export
// ---------------------------------------------------------------------------

export const brandCategoryScan = createWorkflow({
  id: "brandCategoryScan",
  inputSchema: triggerSchema,
  outputSchema: reportOutputSchema,
})
  .then(pickNextTarget)
  .then(loadGraphState)
  .then(scanCategory)
  .then(markAudited)
  .then(writeReport)
  .commit();
