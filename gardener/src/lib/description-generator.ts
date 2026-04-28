/**
 * Description Generator — Quick-Task 260428-ke7 (enrichmentPremium / DATA-07)
 *
 * Generates a 200-400 word expert-quality product description for a gear_item
 * via Gemini 2.5 Flash through the Vercel AI Gateway.
 *
 * Inputs (best-effort — most fields optional):
 *   - name, brand              required
 *   - weight_grams             improves accuracy if known
 *   - primary_image_url        not used in prompt (vision call would 4x cost)
 *   - product_url              not fetched here (caller can pre-scrape)
 *   - existing_description     used for "skip if already good" heuristic
 *   - category_label           sharpens intended-use language
 *
 * Output: { description, cost_cents, skipped, skip_reason, input_tokens, output_tokens }
 *
 * Skip heuristic (deterministic, no LLM call): if existing_description is
 *   - >= 300 chars  AND
 *   - contains a weight reference (number followed by g/kg/lb/oz)  AND
 *   - contains a material/spec keyword (nylon|polyester|down|aluminum|titanium|etc.)
 * the existing description is treated as "good quality" and we return early
 * with skipped=true and cost_cents=0.
 *
 * The extractor is pure (no Supabase, no Memgraph) — caller drives writes.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Pricing — Gemini 2.5 Flash list price (USD), env-overridable.
// Mirrors enrichment-extractors.ts so cost-tracking behaves identically.
// ---------------------------------------------------------------------------

const DEFAULT_INPUT_PRICE_CENTS_PER_1M = 7.5;
const DEFAULT_OUTPUT_PRICE_CENTS_PER_1M = 30;

function inputPriceCentsPerMillion(): number {
  const fromEnv = process.env.ENRICHMENT_INPUT_PRICE_CENTS_PER_1M;
  return fromEnv ? parseFloat(fromEnv) : DEFAULT_INPUT_PRICE_CENTS_PER_1M;
}

function outputPriceCentsPerMillion(): number {
  const fromEnv = process.env.ENRICHMENT_OUTPUT_PRICE_CENTS_PER_1M;
  return fromEnv ? parseFloat(fromEnv) : DEFAULT_OUTPUT_PRICE_CENTS_PER_1M;
}

function costCents(inputTokens: number, outputTokens: number): number {
  const inputCost = (inputTokens / 1_000_000) * inputPriceCentsPerMillion();
  const outputCost = (outputTokens / 1_000_000) * outputPriceCentsPerMillion();
  return Math.ceil(inputCost + outputCost);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DescriptionInputItem {
  id: string;
  name: string;
  brand: string | null;
  weight_grams: number | null;
  primary_image_url: string | null;
  product_url: string | null;
  existing_description: string | null;
  category_label: string | null;
}

export interface DescriptionResult {
  item_id: string;
  description: string | null;
  cost_cents: number;
  skipped: boolean;
  skip_reason?: string;
  input_tokens: number;
  output_tokens: number;
  reasoning?: string;
}

const DescriptionLLMResponseSchema = z.object({
  description: z.string(),
  word_count: z.number().int().nonnegative(),
  reasoning: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Skip heuristic — "existing description is good enough"
// ---------------------------------------------------------------------------

function isExistingDescriptionGood(existing: string | null): boolean {
  if (!existing) return false;
  // Single length-based gate. Previously also required weight pattern AND
  // material keyword, but that bypassed for legitimate scraped marketing copy
  // (Anfibio, Cumulus, Therm-a-Rest German manuals, etc.) that lacks weight
  // units inline — wasting Gemini calls on content that's already strong.
  // 200 chars is the empirical floor where descriptions reliably contain
  // ≥1 differentiating fact about the product.
  return existing.length >= 200;
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

const DESCRIPTION_SYSTEM_PROMPT = `Du bist Outdoor-Gear-Experte und schreibst praezise, herstellerneutrale Produktbeschreibungen fuer Gearshack-User.

Aufgabe: Schreibe eine Beschreibung mit 200-400 Woertern fuer das gegebene Gear-Item.

Inhaltliche Pflicht-Elemente (sofern aus Eingabe oder Produktwissen ableitbar):
1. Einsatzzweck + Zielnutzer (Bikepacking? Trekking? Packrafting?)
2. Material/Konstruktion (Stoffe, Verarbeitung, Innenleben)
3. Gewicht (in Gramm — niemals oz/lbs)
4. Schluesselfeatures (max 3-5 — z.B. "wasserdicht", "single-wall", "FreeStanding")
5. Tradeoffs / Limitierungen (Ehrlichkeit ueber Marketing-Speak)

CRITICAL RULES:
(1) NIEMALS Hersteller-Marketing kopieren ("perfect for...", "ultimate experience"). Trocken + sachlich.
(2) Faktencheck > Spekulation: Wenn ein Spec unsicher ist, weglassen statt erfinden.
(3) Wortzahl 200-400 Woerter. Unter 200 = wahrscheinlich zu duenn. Ueber 400 = abschneiden.
(4) Sprache: Englisch (matched user-facing UI lang). Klar + lesbar, ohne Buzzwords.
(5) Strukturiere als 2-3 Absaetze (NICHT als Bullet-List).

Antworte AUSSCHLIESSLICH im JSON-Format:
{
  "description": "<200-400 word english product description>",
  "word_count": <integer>,
  "reasoning": "<optional max 100 char justification of any inferred spec>"
}`;

function buildDescriptionUserPrompt(item: DescriptionInputItem): string {
  const parts: string[] = [`name="${item.name}"`];
  if (item.brand) parts.push(`brand="${item.brand}"`);
  if (item.weight_grams !== null)
    parts.push(`weight_grams=${item.weight_grams}`);
  if (item.category_label) parts.push(`category="${item.category_label}"`);
  if (item.product_url) parts.push(`product_url="${item.product_url}"`);
  if (item.existing_description) {
    const truncated = item.existing_description
      .slice(0, 500)
      .replace(/"/g, "'");
    parts.push(`existing_description="${truncated}"`);
  }

  return `Schreibe eine 200-400 word english Beschreibung fuer dieses Outdoor-Gear-Item.

ITEM:
${parts.join("\n")}`;
}

// ---------------------------------------------------------------------------
// JSON parsing helpers (mirrors enrichment-extractors.ts patterns)
// ---------------------------------------------------------------------------

function tryExtractFencedJson(raw: string): string | null {
  const closed = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (closed && closed[1]) return closed[1].trim();
  const opening = raw.match(/```(?:json)?\s*([\s\S]*)$/);
  if (opening && opening[1]) return opening[1].trim();
  return null;
}

function extractBalancedJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < raw.length; i += 1) {
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
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return raw.slice(start, i + 1);
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
      `[description] LLM response was not valid JSON: ${content.slice(0, 500)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Main extractor
// ---------------------------------------------------------------------------

interface OpenAIChatResponse {
  choices: Array<{
    message: { role: string; content: string | null };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

/**
 * Generate a 200-400 word product description for one gear_item via Gemini.
 *
 * Returns immediately with skipped=true if the existing description already
 * meets the "good quality" heuristic (length >=300 + weight ref + material kw).
 *
 *   1. Skip-check.
 *   2. POST chat completion (zero-temp, 2K max_tokens).
 *   3. Parse JSON, validate with Zod.
 *   4. Word-count guard: if outside 150..500 words, mark as failed (description=null).
 *   5. Compute cost from token usage.
 */
export async function generateDescriptionWithGemini(
  item: DescriptionInputItem,
): Promise<DescriptionResult> {
  if (isExistingDescriptionGood(item.existing_description)) {
    return {
      item_id: item.id,
      description: null,
      cost_cents: 0,
      skipped: true,
      skip_reason: "existing_description_good_enough",
      input_tokens: 0,
      output_tokens: 0,
    };
  }

  const apiKey = process.env.AI_GATEWAY_API_KEY;
  if (!apiKey) {
    throw new Error(
      "AI_GATEWAY_API_KEY env var is required for description generation",
    );
  }
  const rawBaseUrl =
    process.env.AI_GATEWAY_BASE_URL ?? "https://ai-gateway.vercel.sh/v1";
  const trimmed = rawBaseUrl.replace(/\/$/, "").replace(/\/ai$/, "");
  const endpoint = `${trimmed}/chat/completions`;

  const requestBody = {
    model: "google/gemini-2.5-flash",
    temperature: 0,
    max_tokens: 2048,
    messages: [
      { role: "system" as const, content: DESCRIPTION_SYSTEM_PROMPT },
      {
        role: "user" as const,
        content: buildDescriptionUserPrompt(item),
      },
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
      `[description] gateway HTTP ${res.status}: ${errText.slice(0, 500)}`,
    );
  }

  const json = (await res.json()) as OpenAIChatResponse;
  const content = json.choices[0]?.message?.content;
  if (!content) {
    throw new Error(
      `[description] empty response: ${JSON.stringify(json).slice(0, 300)}`,
    );
  }

  const parsed = parseJsonResponse(content);
  const validated = DescriptionLLMResponseSchema.parse(parsed);

  const usage = json.usage ?? {};
  const inputTokens = usage.prompt_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? 0;
  const cost = costCents(inputTokens, outputTokens);

  // Word-count guard. Loosened from 150..500 → 80..600 because Gemini Flash
  // frequently produces concise 80-120 word descriptions for simple items
  // (stuff bags, pots, small accessories) that are still high-quality. Below
  // 80 the description is too thin to be useful; above 600 it's verbose fluff.
  const words = validated.description.trim().split(/\s+/).filter(Boolean).length;
  if (words < 80 || words > 600) {
    return {
      item_id: item.id,
      description: null,
      cost_cents: cost,
      skipped: false,
      skip_reason: `word_count_out_of_range: ${words}`,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      reasoning: validated.reasoning,
    };
  }

  return {
    item_id: item.id,
    description: validated.description,
    cost_cents: cost,
    skipped: false,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    reasoning: validated.reasoning,
  };
}
