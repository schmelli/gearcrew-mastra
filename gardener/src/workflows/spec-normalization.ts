import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { getReadSession, getWriteSession } from "../lib/memgraph.js";

// ─── Validation & Sanitization (exported for tests) ───────────────────────────

export function validateSpec(key: string, value: unknown): boolean {
  // Reject empty strings and overly long strings regardless of field
  if (typeof value === "string" && (value.trim().length === 0 || value.length > 500)) {
    return false;
  }

  const validators: Record<string, (v: unknown) => boolean> = {
    spec_volume_liters: (v) => typeof v === "number" && v > 0 && v < 1000,
    spec_waterproof_mm: (v) => typeof v === "number" && v >= 0 && v <= 100000,
    spec_temp_rating_c: (v) => typeof v === "number" && v >= -60 && v <= 40,
    spec_fill_power: (v) => typeof v === "number" && v >= 400 && v <= 1200,
    spec_material_face: (v) =>
      typeof v === "string" && v.trim().length > 0 && v.length < 100,
    spec_material_insulation: (v) =>
      typeof v === "string" && v.trim().length > 0 && v.length < 100,
    spec_packed_size_cm: (v) =>
      typeof v === "string" && /^\d+x\d+/.test(v as string),
    spec_r_value: (v) => typeof v === "number" && v >= 0 && v <= 20,
    spec_poles_included: (v) => typeof v === "boolean",
    spec_seasons: (v) =>
      typeof v === "number" && [1, 2, 3, 4].includes(v as number),
  };
  return validators[key]?.(value) ?? false;
}

export function sanitizeSpecs(
  rawSpecs: Record<string, unknown>,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawSpecs)) {
    if (value !== null && value !== undefined && validateSpec(key, value)) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

// ─── Zod schemas ───────────────────────────────────────────────────────────────

const triggerSchema = z.object({
  dryRun: z.boolean().default(false),
  productTypeSlugs: z.array(z.string()).optional(),
  batchSize: z.number().default(100),
  overwriteExisting: z.boolean().default(false),
});

const gearItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  typeSlug: z.string().nullable(),
  category: z.string().nullable(),
});

const fetchOutput = z.object({
  items: z.array(gearItemSchema),
  dryRun: z.boolean(),
  overwriteExisting: z.boolean(),
});

const extractedItemSchema = z.object({
  id: z.string(),
  specs: z.record(z.unknown()),
});

const extractOutput = z.object({
  items: z.array(gearItemSchema),
  extracted: z.array(extractedItemSchema),
  dryRun: z.boolean(),
});

const validatedItemSchema = z.object({
  id: z.string(),
  sanitizedSpecs: z.record(z.unknown()),
  specCount: z.number(),
});

const validateOutput = z.object({
  items: z.array(gearItemSchema),
  validated: z.array(validatedItemSchema),
  dryRun: z.boolean(),
});

const writeOutput = z.object({
  items: z.array(gearItemSchema),
  validated: z.array(validatedItemSchema),
  written: z.number(),
  skipped: z.number(),
  dryRun: z.boolean(),
});

const summaryOutput = z.object({
  itemsProcessed: z.number(),
  specsExtracted: z.record(z.number()),
  averageSpecsPerItem: z.number(),
  topTypes: z.array(z.object({ slug: z.string(), count: z.number() })),
});

// ─── Step 1: fetch-items-needing-specs ────────────────────────────────────────

const fetchItemsNeedingSpecs = createStep({
  id: "fetch-items-needing-specs",
  description:
    "Fetch GearItems that have descriptions but no extracted specs yet",
  inputSchema: triggerSchema,
  outputSchema: fetchOutput,
  execute: async ({ inputData }) => {
    const { batchSize, productTypeSlugs, overwriteExisting, dryRun } =
      inputData;

    const session = getReadSession();

    try {
      const query = `
MATCH (g:GearItem)
WHERE g.description IS NOT NULL
  AND ($overwrite OR g.specs_extracted_at IS NULL)
  AND ($slugs IS NULL OR g.productTypeSlug IN $slugs)
RETURN toString(id(g)) as id, g.name as name, g.description as description,
       g.productTypeSlug as type_slug, g.category as category
ORDER BY g.productTypeSlug, g.name
LIMIT $batchSize`;

      const result = await session.run(query, {
        batchSize,
        slugs: productTypeSlugs ?? null,
        overwrite: overwriteExisting,
      });

      const items = result.records.map((r) => ({
        id: r.get("id") as string,
        name: r.get("name") as string,
        description: r.get("description") as string,
        typeSlug: r.get("type_slug") as string | null,
        category: r.get("category") as string | null,
      }));

      console.log(
        `[fetch-items-needing-specs] Found ${items.length} items to process`,
      );
      return { items, dryRun, overwriteExisting };
    } finally {
      await session.close();
    }
  },
});

// ─── Step 2: extract-specs-with-haiku ────────────────────────────────────────

const extractSpecsWithHaiku = createStep({
  id: "extract-specs-with-haiku",
  description:
    "Use Claude Haiku to extract structured specs from product descriptions (10 items per call)",
  inputSchema: fetchOutput,
  outputSchema: extractOutput,
  execute: async ({ inputData }) => {
    const { items, dryRun } = inputData;

    if (items.length === 0) {
      console.log("[extract-specs-with-haiku] No items to process");
      return { items, extracted: [], dryRun };
    }

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const BATCH_SIZE = 10;
    const allExtracted: Array<{ id: string; specs: Record<string, unknown> }> =
      [];

    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const batch = items.slice(i, i + BATCH_SIZE);
      console.log(
        `[extract-specs-with-haiku] Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(items.length / BATCH_SIZE)} (${batch.length} items)`,
      );

      const prompt = `Extract technical specifications from these outdoor gear product descriptions.
For each product, extract ONLY explicitly stated values (do NOT infer or guess).
Return null for any spec that is not clearly stated.

Products:
${batch.map((item, idx) => `[${idx}] ${item.name} (${item.typeSlug ?? item.category ?? "unknown"})\n${item.description.slice(0, 800)}`).join("\n\n")}

Return a JSON array with one object per product, using the 0-based itemIndex from the list above:
[
  {
    "itemIndex": 0,
    "specs": {
      "spec_volume_liters": number|null,
      "spec_waterproof_mm": number|null,
      "spec_temp_rating_c": number|null,
      "spec_fill_power": number|null,
      "spec_material_face": string|null,
      "spec_material_insulation": string|null,
      "spec_packed_size_cm": string|null,
      "spec_r_value": number|null,
      "spec_poles_included": boolean|null,
      "spec_seasons": number|null
    }
  }
]

Rules:
- Temperatures: always in Celsius (convert F if needed: (F-32)*5/9)
- Volume: always in liters (convert cubic inches: /61.024)
- Waterproof: in mm waterhead (convert "10k" → 10000)
- R-value: as decimal (e.g. 4.2)
- Only include a spec if it's explicitly mentioned in the description
- Use "itemIndex" (the 0-based integer index shown in brackets above, e.g. 0, 1, 2...) to identify each product
- For material_face: just the fabric name, not the weight/denier`;

      let responseText = "";
      try {
        const response = await anthropic.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 2000,
          messages: [{ role: "user", content: prompt }],
        });
        responseText =
          response.content[0].type === "text" ? response.content[0].text : "";
      } catch (err) {
        console.error(
          `[extract-specs-with-haiku] Haiku call failed for batch starting at ${i}:`,
          err,
        );
        continue;
      }

      try {
        const jsonMatch = responseText.match(/\[[\s\S]*\]/);
        if (!jsonMatch) {
          console.warn(
            `[extract-specs-with-haiku] No JSON array found in response for batch ${i}`,
          );
          continue;
        }

        const parsed = JSON.parse(jsonMatch[0]) as Array<{
          itemIndex?: number;
          id?: string;
          specs: Record<string, unknown>;
        }>;

        for (const entry of parsed) {
          // Primary: use itemIndex (0-based) to look up the real Memgraph ID from the batch
          let realId: string | undefined;
          if (typeof entry.itemIndex === "number") {
            realId = batch[entry.itemIndex]?.id;
          } else if (entry.id !== undefined) {
            // Legacy fallback: if model returned an "id" field, check if it's a
            // numeric index (old prompt style) or an actual Memgraph string ID
            const idStr = String(entry.id);
            const asIndex = parseInt(idStr, 10);
            if (!isNaN(asIndex) && asIndex >= 0 && asIndex < batch.length) {
              realId = batch[asIndex]?.id;
            } else {
              realId = idStr;
            }
          }

          if (!realId) {
            console.warn(
              `[extract-specs-with-haiku] Could not resolve ID for entry in batch ${i}:`,
              entry,
            );
            continue;
          }

          allExtracted.push({
            id: realId,
            specs: entry.specs ?? {},
          });
        }
      } catch (err) {
        console.error(
          `[extract-specs-with-haiku] JSON parse failed for batch ${i}:`,
          err,
        );
      }

      // Small delay between batches
      if (i + BATCH_SIZE < items.length) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    console.log(
      `[extract-specs-with-haiku] Extracted specs for ${allExtracted.length} items`,
    );
    return { items, extracted: allExtracted, dryRun };
  },
});

// ─── Step 3: validate-specs ───────────────────────────────────────────────────

const validateSpecsStep = createStep({
  id: "validate-specs",
  description:
    "Validate and sanitize extracted specs, filtering out invalid values",
  inputSchema: extractOutput,
  outputSchema: validateOutput,
  execute: async ({ inputData }) => {
    const { items, extracted, dryRun } = inputData;

    const validated = extracted.map((item) => {
      const sanitizedSpecs = sanitizeSpecs(
        item.specs as Record<string, unknown>,
      );
      return {
        id: item.id,
        sanitizedSpecs,
        specCount: Object.keys(sanitizedSpecs).length,
      };
    });

    const withSpecs = validated.filter((v) => v.specCount > 0);
    console.log(
      `[validate-specs] ${withSpecs.length}/${validated.length} items have at least 1 valid spec`,
    );

    return { items, validated, dryRun };
  },
});

// ─── Step 4: write-specs ──────────────────────────────────────────────────────

const writeSpecsStep = createStep({
  id: "write-specs",
  description:
    "Write validated specs to Memgraph GearItem nodes (skipped in dryRun mode)",
  inputSchema: validateOutput,
  outputSchema: writeOutput,
  execute: async ({ inputData }) => {
    const { items, validated, dryRun } = inputData;

    const actionable = validated.filter((v) => v.specCount > 0);

    if (dryRun) {
      console.log(
        `[write-specs] DRY RUN — would write specs for ${actionable.length} items`,
      );
      for (const item of actionable.slice(0, 5)) {
        console.log(
          `  DRY: id=${item.id} specs=${JSON.stringify(item.sanitizedSpecs)}`,
        );
      }
      return {
        items,
        validated,
        written: 0,
        skipped: actionable.length,
        dryRun: true,
      };
    }

    let written = 0;
    let skipped = 0;
    const session = getWriteSession();

    try {
      for (const item of actionable) {
        const { sanitizedSpecs } = item;

        const setClauses = Object.entries(sanitizedSpecs)
          .map(([key]) => `g.${key} = $${key}`)
          .join(", ");

        const query = `
MATCH (g:GearItem) WHERE toString(id(g)) = $id
SET ${setClauses}, g.specs_extracted_at = datetime()`;

        try {
          await session.run(query, {
            id: item.id,
            ...sanitizedSpecs,
          });
          written++;
        } catch (err) {
          console.error(
            `[write-specs] Failed to write specs for item ${item.id}:`,
            err,
          );
          skipped++;
        }
      }
    } finally {
      await session.close();
    }

    console.log(`[write-specs] Written: ${written}, Skipped: ${skipped}`);
    return { items, validated, written, skipped, dryRun: false };
  },
});

// ─── Step 5: summary ──────────────────────────────────────────────────────────

const summaryStep = createStep({
  id: "summary",
  description:
    "Summarise the run: items processed, specs extracted by type, top product types",
  inputSchema: writeOutput,
  outputSchema: summaryOutput,
  execute: async ({ inputData }) => {
    const { items, validated } = inputData;

    const itemsProcessed = items.length;
    const specsExtracted: Record<string, number> = {};
    let totalSpecCount = 0;

    for (const item of validated) {
      totalSpecCount += item.specCount;
      for (const key of Object.keys(item.sanitizedSpecs)) {
        specsExtracted[key] = (specsExtracted[key] ?? 0) + 1;
      }
    }

    const averageSpecsPerItem =
      validated.length > 0
        ? Math.round((totalSpecCount / validated.length) * 100) / 100
        : 0;

    // Count items per productTypeSlug
    const typeCounts: Record<string, number> = {};
    for (const item of items) {
      const slug = item.typeSlug ?? "unknown";
      typeCounts[slug] = (typeCounts[slug] ?? 0) + 1;
    }

    const topTypes = Object.entries(typeCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([slug, count]) => ({ slug, count }));

    console.log(
      `[summary] itemsProcessed=${itemsProcessed} avgSpecs=${averageSpecsPerItem} topTypes=${topTypes.map((t) => t.slug).join(", ")}`,
    );

    return { itemsProcessed, specsExtracted, averageSpecsPerItem, topTypes };
  },
});

// ─── Workflow ──────────────────────────────────────────────────────────────────

export const specNormalization = createWorkflow({
  id: "spec-normalization",
  inputSchema: triggerSchema,
  outputSchema: summaryOutput,
})
  .then(fetchItemsNeedingSpecs)
  .then(extractSpecsWithHaiku)
  .then(validateSpecsStep)
  .then(writeSpecsStep)
  .then(summaryStep)
  .commit();
