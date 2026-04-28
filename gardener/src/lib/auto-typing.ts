/**
 * Auto-Typing Library — Phase 09 / DATA-04 (GEA-1085)
 *
 * Per-batch Gemini classifier that maps untyped gear_items to existing
 * canonical ProductType-Categories (Top-50). Caller is the autoTypingFlash
 * workflow; this lib is a pure LLM client (NO Supabase imports).
 *
 * Pattern adapted from `type-clustering.ts`:
 *   - Vercel AI Gateway OpenAI-compatible chat/completions endpoint
 *   - google/gemini-2.5-flash (locked default per CONTEXT D-14)
 *   - JSON parse cascade: direct → fenced → balanced { ... }
 *   - Token-based cost estimation with env-overridable pricing
 *   - Hallucination-guard: drop suggestions whose suggested_product_type_id
 *     is not in the candidate-id-set (set to null + confidence=0).
 *
 * Differences vs type-clustering:
 *   - Schema: items + candidates → results-array (per-item classification)
 *   - No estimateCostCents pre-call abort — caller drives cost-cap by
 *     accumulating cost across batches and aborting BEFORE the next batch.
 *   - Confidence scale: 1.0=exact, 0.85-0.95=clear, 0.7-0.85=plausible,
 *     <0.7=uncertain. Caller filters with confidence_threshold.
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const BatchInputSchema = z.object({
  items: z.array(
    z.object({
      id: z.string().uuid(),
      name: z.string(),
      brand: z.string().nullable(),
      category_legacy: z.string().nullable(),
      weight_grams: z.number().nullable(),
      description: z.string().nullable(),
    }),
  ),
  candidates: z.array(
    z.object({
      id: z.string().uuid(),
      name: z.string(),
    }),
  ),
});

export type BatchInput = z.infer<typeof BatchInputSchema>;

const LLMItemResultSchema = z.object({
  item_id: z.string().uuid(),
  suggested_product_type_id: z.string().uuid().nullable(),
  suggested_label: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});

export type LLMItemResult = z.infer<typeof LLMItemResultSchema>;

const LLMResponseSchema = z.object({
  results: z.array(LLMItemResultSchema),
});

// ---------------------------------------------------------------------------
// Pricing — defaults match Gemini 2.5 Flash list price (USD).
// Override with env vars AUTO_TYPING_INPUT_PRICE_CENTS_PER_1M and
// AUTO_TYPING_OUTPUT_PRICE_CENTS_PER_1M to recalibrate after first real run.
// ---------------------------------------------------------------------------

const DEFAULT_INPUT_PRICE_CENTS_PER_1M = 7.5; // $0.075 / 1M tokens
const DEFAULT_OUTPUT_PRICE_CENTS_PER_1M = 30; // $0.30  / 1M tokens

function inputPriceCentsPerMillion(): number {
  const fromEnv = process.env.AUTO_TYPING_INPUT_PRICE_CENTS_PER_1M;
  return fromEnv ? parseFloat(fromEnv) : DEFAULT_INPUT_PRICE_CENTS_PER_1M;
}

function outputPriceCentsPerMillion(): number {
  const fromEnv = process.env.AUTO_TYPING_OUTPUT_PRICE_CENTS_PER_1M;
  return fromEnv ? parseFloat(fromEnv) : DEFAULT_OUTPUT_PRICE_CENTS_PER_1M;
}

function costCents(inputTokens: number, outputTokens: number): number {
  const inputCost = (inputTokens / 1_000_000) * inputPriceCentsPerMillion();
  const outputCost = (outputTokens / 1_000_000) * outputPriceCentsPerMillion();
  return Math.ceil(inputCost + outputCost);
}

// ---------------------------------------------------------------------------
// System prompt — strict, conservative classification per CONTEXT D-14/D-17.
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `Du klassifizierst outdoor-gear items in EXAKT eine ProductType-Kategorie aus einer vorgegebenen Liste.

Aufgabe: Fuer jedes Input-Item entscheide, welche der gelisteten Kandidaten-Kategorien (Top-50 ProductTypes wie Tent, Daypack, Sleeping Bag, etc.) am besten passt — basierend auf name, brand, category_legacy, weight_grams und description.

CRITICAL RULES:
(1) suggested_product_type_id MUSS eine UUID aus der candidates-Liste sein, NIEMALS erfunden. Wenn keine Kategorie passt → suggested_product_type_id=null, confidence=0.
(2) suggested_label muss exakt mit dem name des gewaehlten candidate uebereinstimmen.
(3) confidence-Skala (KONSERVATIV — bei Unsicherheit niedriger waehlen):
    1.0   = name enthaelt den Kategorie-Namen explizit ("UL Daypack 25L" → Daypack)
    0.85-0.95 = klare semantische Zuordnung (Brand+Description macht Type eindeutig)
    0.7-0.85  = plausibel, aber name allein nicht eindeutig
    <0.7  = unsicher → wird in Review-Queue gefiltert
(4) Wenn category_legacy einen klaren Hint gibt ("tents" → Tent-Kategorie), nutze ihn — aber NUR wenn er zur einer canonical-Kategorie matched.
(5) Bei mehrdeutigen Namen ("Foo 3000 Pro", "Generic Widget Mk II") → confidence < 0.7 setzen, Reasoning warum unsicher.
(6) Brand allein darf NIE zur Klassifikation reichen ("Patagonia" → kann fast alles sein).
(7) reasoning kurz halten (max 200 Zeichen) — z.B. "name 'UL Daypack 25L' matches Daypack canonical exactly".

Antworte AUSSCHLIESSLICH im JSON-Format. Keine zusaetzlichen Felder, keine Erklaerungen ausserhalb von reasoning.`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ClassifyBatchOptions {
  modelIdOverride?: string;
}

export interface ClassifyBatchResult {
  results: LLMItemResult[];
  cost_cents: number;
  input_tokens: number;
  output_tokens: number;
  generation_id?: string;
}

function resolveModelId(override?: string): `${string}/${string}` {
  // Default = google/gemini-2.5-flash always (D-14 production lock).
  // Caller may pass an override for debug/dry-run-test runs.
  const raw = override ?? "google/gemini-2.5-flash";
  if (!raw.includes("/")) {
    throw new Error(
      `auto-typing model id must be a "<provider>/<model>" string, got: ${raw}`,
    );
  }
  return raw as `${string}/${string}`;
}

function buildUserPrompt(input: BatchInput): string {
  const itemLines = input.items.map((it) => {
    const parts = [
      `id=${it.id}`,
      `name="${it.name}"`,
      it.brand ? `brand="${it.brand}"` : "",
      it.category_legacy ? `category_legacy="${it.category_legacy}"` : "",
      it.weight_grams !== null ? `weight_grams=${it.weight_grams}` : "",
      it.description
        ? `description="${it.description.slice(0, 200).replace(/"/g, "'")}"`
        : "",
    ].filter(Boolean);
    return `- ${parts.join(" ")}`;
  });

  const candLines = input.candidates.map(
    (c) => `- id=${c.id} name="${c.name}"`,
  );

  return `Klassifiziere die folgenden ${input.items.length} gear_items in genau eine der ${input.candidates.length} candidate-Kategorien.

Output: JSON object { "results": [...] } mit fuer JEDES item:
  - item_id (UUID, MUSS aus den Input-items stammen)
  - suggested_product_type_id (UUID aus candidates ODER null wenn unsicher)
  - suggested_label (string, exact wie im candidate-name, ODER null)
  - confidence (number 0..1)
  - reasoning (string, max 200 Zeichen)

CANDIDATES (${input.candidates.length}):
${candLines.join("\n")}

ITEMS (${input.items.length}):
${itemLines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// HTTP shapes for the Vercel AI Gateway OpenAI-compatible endpoint
// ---------------------------------------------------------------------------

interface OpenAIChatResponse {
  id?: string;
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
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
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
    if (balanced) {
      return JSON.parse(balanced);
    }
    throw new Error(
      `[auto-typing] LLM response was not valid JSON: ${content.slice(0, 500)}...`,
    );
  }
}

/**
 * Classify a batch of gear_items via Vercel AI Gateway (OpenAI-compatible
 * chat/completions endpoint).
 *
 *   1. POST chat completion with strict JSON output instruction.
 *   2. Parse + validate with Zod.
 *   3. Hallucination-guard: any result with suggested_product_type_id NOT in
 *      the candidates id-set is rewritten to { suggested_product_type_id: null,
 *      confidence: 0 } so the caller treats it as failed.
 *   4. Compute cost from usage (token-based; Gateway-class info would be more
 *      precise but defensive — token-based fallback is the contract).
 */
export async function classifyBatch(
  input: BatchInput,
  opts: ClassifyBatchOptions,
): Promise<ClassifyBatchResult> {
  const validated = BatchInputSchema.parse(input);
  if (validated.items.length === 0) {
    return {
      results: [],
      cost_cents: 0,
      input_tokens: 0,
      output_tokens: 0,
    };
  }
  if (validated.candidates.length === 0) {
    throw new Error("[auto-typing] candidates array is empty");
  }

  const modelId = resolveModelId(opts.modelIdOverride);
  const apiKey = process.env.AI_GATEWAY_API_KEY;
  if (!apiKey) {
    throw new Error(
      "AI_GATEWAY_API_KEY env var is required for auto-typing classifier",
    );
  }
  const rawBaseUrl =
    process.env.AI_GATEWAY_BASE_URL ?? "https://ai-gateway.vercel.sh/v1";
  const trimmed = rawBaseUrl.replace(/\/$/, "").replace(/\/ai$/, "");
  const endpoint = `${trimmed}/chat/completions`;

  console.log(
    `[auto-typing] calling ${modelId} via ${endpoint} — ${validated.items.length} items, ${validated.candidates.length} candidates`,
  );

  const schemaHint = JSON.stringify(zodToJsonSchema(LLMResponseSchema), null, 2);

  // Vercel AI Gateway routes to Vertex/Gemini for google/gemini-* models and
  // Vertex rejects `response_format: { type: 'json_object' }`. Prompt-only
  // JSON instruction + parseJsonResponse() cascade.
  interface ChatRequestBody {
    model: string;
    temperature: number;
    max_tokens: number;
    response_format?: { type: "json_object" };
    messages: Array<{ role: "system" | "user"; content: string }>;
  }
  const requestBody: ChatRequestBody = {
    model: modelId,
    temperature: 0,
    max_tokens: 32000,
    messages: [
      {
        role: "system",
        content: `${SYSTEM_PROMPT}\n\nReturn JSON exactly matching this schema. Output ONLY the JSON object — no markdown fence, no explanation, no leading/trailing text:\n\`\`\`json\n${schemaHint}\n\`\`\``,
      },
      { role: "user", content: buildUserPrompt(validated) },
    ],
  };
  if (!modelId.startsWith("google/")) {
    requestBody.response_format = { type: "json_object" };
  }

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
      `[auto-typing] gateway HTTP ${res.status}: ${errText.slice(0, 500)}`,
    );
  }

  const json = (await res.json()) as OpenAIChatResponse;
  const content = json.choices[0]?.message?.content;
  if (!content) {
    throw new Error(
      `[auto-typing] empty response from ${modelId}: ${JSON.stringify(json).slice(0, 300)}`,
    );
  }

  const parsed = parseJsonResponse(content);
  const validatedResponse = LLMResponseSchema.parse(parsed);

  const usage = json.usage ?? {};
  const inputTokens = usage.prompt_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? 0;
  const actualCost = costCents(inputTokens, outputTokens);

  // Hallucination-guard: drop suggestions whose suggested_product_type_id is
  // not in the candidate id-set. Rewrite to null + confidence=0 (failed).
  const candidateIdSet = new Set(validated.candidates.map((c) => c.id));
  const itemIdSet = new Set(validated.items.map((it) => it.id));
  let halluCount = 0;
  let unknownItemCount = 0;
  const cleaned: LLMItemResult[] = [];
  for (const r of validatedResponse.results) {
    if (!itemIdSet.has(r.item_id)) {
      unknownItemCount += 1;
      // Skip — cannot map back to an input item.
      continue;
    }
    if (
      r.suggested_product_type_id !== null &&
      !candidateIdSet.has(r.suggested_product_type_id)
    ) {
      halluCount += 1;
      cleaned.push({
        item_id: r.item_id,
        suggested_product_type_id: null,
        suggested_label: null,
        confidence: 0,
        reasoning: `hallucination_guard: suggested id ${r.suggested_product_type_id} not in candidates (orig reasoning: ${r.reasoning.slice(0, 100)})`,
      });
      continue;
    }
    cleaned.push(r);
  }

  if (halluCount > 0) {
    console.warn(
      `[auto-typing] hallucination-guard rewrote ${halluCount} suggestions to null (id not in candidates)`,
    );
  }
  if (unknownItemCount > 0) {
    console.warn(
      `[auto-typing] ${unknownItemCount} LLM results referenced unknown item_ids — dropped`,
    );
  }

  console.log(
    `[auto-typing] OK — ${cleaned.length}/${validated.items.length} classifications returned, ${actualCost}¢ used (in=${inputTokens}, out=${outputTokens})`,
  );

  return {
    results: cleaned,
    cost_cents: actualCost,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    generation_id: json.id,
  };
}
