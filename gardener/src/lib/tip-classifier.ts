/**
 * Tip/Insight Classifier — Phase 1 of the 3-level insights restructure.
 *
 * Reads existing :Insight nodes connected via HAS_TIP edges to GearItems and
 * classifies each into one of four scope buckets:
 *
 *   GENERIC  — applies to whole product type / category
 *              ("Lass deinen Filter nicht gefrieren" → all water filters)
 *   FAMILY   — applies to product family / series, not just one variant
 *              ("Alle Anaris sind freistehend" → entire Anaris series)
 *   SPECIFIC — applies only to this specific product
 *              ("Anaris 2P hat 2 Eingänge" → only the 2P variant)
 *   AMBIGUOUS — confidence below threshold; preserve current state for review
 *
 * Classification is stored on the Insight node as new properties; no
 * structural migration happens in this phase. That comes in Phase 2.
 *
 * Batched: 50 tips per Gemini call. Cost ~$0.0003 per call → $0.06 for 9686.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TipForClassification {
  insight_id: string;        // Memgraph internal ID (string form)
  insight_text: string;       // tip content / summary
  gear_item_brand: string;
  gear_item_name: string;
  product_family_name: string | null;
  product_type_name: string | null;
  family_sibling_count: number;  // how many GearItems share this family (helps classifier judge "family-level"?)
}

export interface TipClassification {
  insight_id: string;
  classification: "GENERIC" | "FAMILY" | "SPECIFIC" | "AMBIGUOUS";
  confidence: number;        // 0..1
  reasoning: string;         // short justification (≤200 chars)
}

const ClassificationSchema = z.object({
  // LLM may return insight_id as either a string OR a number — coerce to string.
  insight_id: z.coerce.string(),
  classification: z.enum(["GENERIC", "FAMILY", "SPECIFIC", "AMBIGUOUS"]),
  confidence: z.coerce.number().min(0).max(1),
  reasoning: z.string().max(2000),
});

const BatchResponseSchema = z.object({
  classifications: z.array(ClassificationSchema),
});

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You classify outdoor-gear insights extracted from product reviews.

For each insight, decide its SCOPE:

  GENERIC  — wisdom that applies to a whole category, transferable across many products.
             Example: "Don't let your water filter freeze" → all water filters.
             Example: "Store down gear uncompressed" → all down products.
             Example: "Check tent floor for sharp objects before pitching" → all tents.

  FAMILY   — applies to all variants in a product family/series, not just one.
             Example: "All Hilleberg Anaris models are freestanding" → series-level.
             Example: "Sea-to-Summit Spark Pro line uses 850-fill down" → series-level.

  SPECIFIC — applies ONLY to one specific product.
             Example: "Anaris 2P weighs 200g more than the 1P" → product-specific.
             Example: "Soto Amicus has larger burner surface than BRS 3000" → product comparison.
             Example: "Nemo Tensor Elite 2025 is rated to -10°C" → product spec.

  AMBIGUOUS — cannot tell, or insight is unclear/contradictory; pick this if confidence < 0.7.

Decision heuristics:
  • If the insight names a SPECIFIC model (with version number, year, color, size variant) → SPECIFIC
  • If the insight names a FAMILY/SERIES (not a specific variant) → FAMILY
  • If the insight does not require knowing the product brand/name → GENERIC
  • If the insight is generic but used as an example tied to one product (e.g. "the filter (here Sawyer) shouldn't freeze") → GENERIC
  • Comparisons between two specific products → SPECIFIC
  • Spec sheet facts (weight, materials, dimensions of THIS product) → SPECIFIC

Output: a JSON array. NO markdown fences. NO commentary outside the JSON.

Format:
{
  "classifications": [
    {"insight_id": "<id>", "classification": "GENERIC|FAMILY|SPECIFIC|AMBIGUOUS", "confidence": 0.0..1.0, "reasoning": "<≤200 chars>"},
    ...
  ]
}`;

function buildBatchUserPrompt(tips: TipForClassification[]): string {
  const lines: string[] = [];
  lines.push(`Classify ${tips.length} insights below.\n`);
  for (const t of tips) {
    lines.push(`---`);
    lines.push(`insight_id: ${t.insight_id}`);
    lines.push(
      `gear_item: ${t.gear_item_brand} / ${t.gear_item_name}`,
    );
    if (t.product_family_name) {
      lines.push(
        `product_family: ${t.product_family_name} (siblings=${t.family_sibling_count})`,
      );
    }
    if (t.product_type_name) {
      lines.push(`product_type: ${t.product_type_name}`);
    }
    lines.push(`insight_text: ${t.insight_text}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// JSON parsing (mirrors description-generator.ts pattern)
// ---------------------------------------------------------------------------

function tryExtractFencedJson(raw: string): string | null {
  // Match ```json ... ``` first (with closing fence)
  const closed = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n```/i);
  if (closed?.[1]) return closed[1];
  // Fallback: response truncated — fence opened but never closed.
  // Take everything after the opening fence.
  const open = raw.match(/```(?:json)?\s*\n?([\s\S]+)$/i);
  return open?.[1] ?? null;
}

function extractBalancedJsonObject(raw: string): string | null {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

function parseJsonResponse(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    const fenced = tryExtractFencedJson(content);
    if (fenced) {
      try {
        return JSON.parse(fenced);
      } catch {
        // fall through
      }
    }
    const balanced = extractBalancedJsonObject(content);
    if (balanced) return JSON.parse(balanced);
    throw new Error(
      `[tip-classifier] LLM response was not valid JSON: ${content.slice(0, 500)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

// Gemini 2.5 Flash via Vercel AI Gateway
//   $0.075 / 1M input tokens, $0.30 / 1M output tokens
function costCents(inputTokens: number, outputTokens: number): number {
  const usd = (inputTokens * 0.075 + outputTokens * 0.3) / 1_000_000;
  return Math.ceil(usd * 100);
}

interface OpenAIChatResponse {
  choices: Array<{
    message: { role: string; content: string | null };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Classify a batch of tips. Single Gemini call returns N classifications.
 *
 * Recommended batch size: 50 — fits comfortably in 8k input context with
 * ~150 token tip text, leaves room for output JSON.
 */
export async function classifyTipBatch(
  tips: TipForClassification[],
): Promise<{
  classifications: TipClassification[];
  cost_cents: number;
  input_tokens: number;
  output_tokens: number;
}> {
  const apiKey = process.env.AI_GATEWAY_API_KEY;
  if (!apiKey) {
    throw new Error(
      "AI_GATEWAY_API_KEY env var is required for tip classification",
    );
  }
  const rawBaseUrl =
    process.env.AI_GATEWAY_BASE_URL ?? "https://ai-gateway.vercel.sh/v1";
  const trimmed = rawBaseUrl.replace(/\/$/, "").replace(/\/ai$/, "");
  const endpoint = `${trimmed}/chat/completions`;

  const requestBody = {
    model: "google/gemini-2.5-flash",
    temperature: 0,
    max_tokens: 16384,
    messages: [
      { role: "system" as const, content: SYSTEM_PROMPT },
      { role: "user" as const, content: buildBatchUserPrompt(tips) },
    ],
  };

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(requestBody),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(
      `[tip-classifier] gateway HTTP ${res.status}: ${errText.slice(0, 500)}`,
    );
  }

  const json = (await res.json()) as OpenAIChatResponse;
  const content = json.choices[0]?.message?.content;
  if (!content) {
    throw new Error(
      `[tip-classifier] empty response: ${JSON.stringify(json).slice(0, 300)}`,
    );
  }

  const parsed = parseJsonResponse(content);
  // LLM sometimes returns the bare classifications array, sometimes the
  // {"classifications": [...]} wrapper. Accept both.
  const wrapped = Array.isArray(parsed) ? { classifications: parsed } : parsed;
  const validated = BatchResponseSchema.parse(wrapped);

  const usage = json.usage ?? {};
  const inputTokens = usage.prompt_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? 0;
  const cost = costCents(inputTokens, outputTokens);

  // Demote LOW-confidence items to AMBIGUOUS
  const classifications: TipClassification[] = validated.classifications.map(
    (c) => ({
      ...c,
      classification: c.confidence < 0.7 ? "AMBIGUOUS" : c.classification,
    }),
  );

  return {
    classifications,
    cost_cents: cost,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
  };
}
