import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { ONTOLOGY } from "../lib/ontology.js";

export const validateSchema = createTool({
  id: "validateSchema",
  description: `Validate data against the GearGraph ontology BEFORE writing to the graph.
This is a deterministic check — no LLM involved. It verifies:
- Node labels are valid
- Relationship types are valid
- Required properties are present
ALWAYS call this before graphWrite.`,
  inputSchema: z.object({
    nodeLabel: z
      .string()
      .describe(
        "The node label to validate (e.g., 'GearItem', 'OutdoorBrand')",
      ),
    properties: z
      .record(z.any())
      .describe("The properties to validate"),
    relationships: z
      .array(
        z.object({
          type: z.string(),
          targetLabel: z.string(),
          targetIdentifier: z.record(z.any()),
        }),
      )
      .optional(),
  }),
  outputSchema: z.object({
    valid: z.boolean(),
    errors: z.array(z.string()),
    warnings: z.array(z.string()),
  }),
  execute: async ({ nodeLabel, properties, relationships }) => {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check node label
    if (!ONTOLOGY.nodeLabels.includes(nodeLabel)) {
      errors.push(
        `Unknown node label: ${nodeLabel}. Valid labels: ${ONTOLOGY.nodeLabels.join(", ")}`,
      );
    }

    // Check required properties
    const required = ONTOLOGY.requiredProperties[nodeLabel] || [];
    for (const prop of required) {
      if (!(prop in properties)) {
        errors.push(
          `Missing required property '${prop}' for ${nodeLabel}`,
        );
      }
    }

    // Check relationship types
    if (relationships) {
      for (const rel of relationships) {
        const validRel = ONTOLOGY.relationships.some(
          (r) =>
            r.type === rel.type &&
            r.startLabel === nodeLabel &&
            r.endLabel === rel.targetLabel,
        );
        if (!validRel) {
          errors.push(
            `Invalid relationship: (${nodeLabel})-[:${rel.type}]->(${rel.targetLabel})`,
          );
        }
      }
    }

    // Warnings for data quality
    if (nodeLabel === "GearItem") {
      if (properties.weight_grams == null && properties.weightGrams == null) {
        warnings.push(
          "No weight specified — GearItems should have weight_grams",
        );
      }
      if (properties.price_usd == null && properties.price_eur == null) {
        warnings.push(
          "No price specified — GearItems should have price_usd or price_eur",
        );
      }
      if (!properties.sourceUrl) {
        warnings.push(
          "No sourceUrl — provenance is important for data quality",
        );
      }
    }

    if (nodeLabel === "OutdoorBrand") {
      if (!properties.website) {
        warnings.push(
          "No website specified — OutdoorBrands should have a website URL",
        );
      }
      if (!properties.country) {
        warnings.push(
          "No country specified — OutdoorBrands should have country of origin",
        );
      }
    }

    return { valid: errors.length === 0, errors, warnings };
  },
});
