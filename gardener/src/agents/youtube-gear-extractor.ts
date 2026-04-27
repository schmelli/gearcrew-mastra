/**
 * YouTube Gear Extractor Agent
 *
 * Sonnet-powered agent that reads a YouTube video transcript + metadata
 * and writes structured gear nodes/relationships into the GearGraph.
 *
 * Model choice: Sonnet (gear identification cascades — wrong brand/type
 * recognition produces duplicate or mis-classified nodes).
 */

import { Agent } from "@mastra/core/agent";
import {
  graphQuery,
  graphWrite,
  validateSchema,
  getOntology,
} from "../tools/index.js";

// ---------------------------------------------------------------------------
// Models via Vercel AI Gateway (mirrors gardener-v3.ts pattern)
// ---------------------------------------------------------------------------

const gatewayConfig = {
  url: process.env.AI_GATEWAY_BASE_URL ?? "https://ai-gateway.vercel.sh/v1",
  apiKey: process.env.AI_GATEWAY_API_KEY ?? "",
};

const sonnetModel = {
  ...gatewayConfig,
  id: "anthropic/claude-sonnet-4-5" as const,
};

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export const youtubeGearExtractor = new Agent({
  id: "youtube-gear-extractor",
  name: "YoutubeGearExtractor",
  instructions: `You extract structured gear data from outdoor-gear YouTube video transcripts.

Input: video metadata (title, channel, duration, url) + transcript text.

Output goal: identify mentioned gear items, their brands, categories, and quotable
opinions/specs from the speaker — and write them into the GearGraph (Memgraph).

## Hard rules

- Use graphQuery FIRST to find existing OutdoorBrand and ProductType nodes via fuzzy
  match on toLower(name). DO NOT create new brand nodes if a similar one exists.
  Brand fuzzy: "Therm-A-Rest", "ThermaRest", "Therm a Rest" → match existing
  OutdoorBrand "Therm-a-Rest".
- For each identified GearItem, MERGE on (brand, name) — never CREATE.
  Pattern: \`MERGE (g:GearItem {brand: $brand, name: $name})\`
- weight_grams MUST be an integer in grams. Convert if necessary:
  - 1.45 kg → 1450
  - 3.2 lbs → 1452
  - 16 oz  → 454
  If unsure, do NOT set the property.
- On every node you touch, set:
    extraction_version = 2
    extracted_at = datetime()
    extracted_from_video_id = $videoId
- Always create the link:
    MERGE (v:VideoSource {url: $url})
    MERGE (g)-[:EXTRACTED_FROM]->(v)
- For opinions/specs the speaker gives, attach to VideoSource (not directly to item):
    MERGE (v)-[:HAS_OPINION]->(o:Opinion {text: $text, sentiment: $sentiment})
    where sentiment ∈ {"positive", "neutral", "negative"}.

## Cypher rules (Memgraph, NOT Neo4j)

- ALWAYS MERGE, never CREATE for nodes that might exist (graphWrite blocks non-MERGE).
- Use toLower() for case-insensitive matches — no \`(?i)\` regex flags.
- No NULLS FIRST. Use CASE expressions when needed.
- Parametrized queries only (\$param), never string interpolation.

## Output format

End your response with a JSON summary on its own line:
{
  "itemsCreated": <number>,
  "itemsUpdated": <number>,
  "brandsMatched": [<string>],
  "opinionsAdded": <number>,
  "lowConfidenceFlags": [<string>]
}

Use lowConfidenceFlags to surface ambiguities (e.g. "Could not disambiguate
'BD Storm' between Black Diamond Storm Headlamp and Storm jacket").`,
  model: sonnetModel,
  tools: {
    graphQuery,
    graphWrite,
    validateSchema,
    getOntology,
  },
});

/** Default maxSteps for the extractor — extraction is multi-tool-call heavy. */
export const YOUTUBE_EXTRACTOR_MAX_STEPS = 30;
