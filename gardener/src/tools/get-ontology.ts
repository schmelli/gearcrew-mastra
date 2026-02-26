import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { ONTOLOGY } from "../lib/ontology";

export const getOntology = createTool({
  id: "getOntology",
  description: `Get the current GearGraph ontology — node labels, relationship types,
required properties, and constraints. Use this before generating any Cypher queries
to ensure compliance with the graph schema.`,
  inputSchema: z.object({}),
  outputSchema: z.object({
    nodeLabels: z.array(z.string()),
    relationships: z.array(
      z.object({
        type: z.string(),
        startLabel: z.string(),
        endLabel: z.string(),
        properties: z.array(z.string()).optional(),
      }),
    ),
    requiredProperties: z.record(z.array(z.string())),
    uniqueConstraints: z.record(z.array(z.string())),
    notes: z.string(),
  }),
  execute: async () => {
    return {
      nodeLabels: ONTOLOGY.nodeLabels,
      relationships: ONTOLOGY.relationships,
      requiredProperties: ONTOLOGY.requiredProperties,
      uniqueConstraints: ONTOLOGY.uniqueConstraints,
      notes: ONTOLOGY.notes,
    };
  },
});
