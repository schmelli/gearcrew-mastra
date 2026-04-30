/**
 * Memgraph ProductType Classifier — Phase A of the GearGraph ProductType
 * Backfill. Pure LLM client (no Memgraph imports). Maps a batch of GearItems
 * (brand, name, optional description) to one of the existing :ProductType
 * names already present in Memgraph, OR null if no candidate fits.
 *
 * Pattern adapted from `auto-typing.ts`:
 *   - Vercel AI Gateway OpenAI-compatible chat/completions endpoint
 *   - google/gemini-2.5-flash
 *   - JSON parse cascade: direct -> fenced -> balanced { ... }
 *   - Token-based cost estimation
 *   - Hallucination-guard: drop suggestions whose suggested_product_type
 *     name is not in the candidates list (set to null + confidence=0).
 *
 * Differences vs auto-typing.ts:
 *   - Memgraph candidates are NAME-keyed (no UUIDs in graph world).
 *   - Confidence floor 0.7 enforced by caller (workflow), not here.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export interface GearItemForClassification {
  memgraph_id: string;       // Memgraph internal node ID (string form)
  brand: string;
  name: string;
  description: string | null;
  category_legacy: string | null;
}

export interface ProductTypeCandidate {
  name: string;              // canonical ProductType.name in Memgraph
  description: string | null;
}

export interface ProductTypeClassificationResult {
  memgraph_id: string;
  suggested_type_name: string | null;
  confidence: number;
  reasoning: string;
}

const LLMItemResultSchema = z.object({
  // LLM may return memgraph_id as string OR number — coerce
  memgraph_id: z.coerce.string(),
  suggested_type_name: z.string().nullable(),
  confidence: z.coerce.number().min(0).max(1),
  reasoning: z.string().max(500),
});

const LLMResponseSchema = z.object({
  results: z.array(LLMItemResultSchema),
});

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

function costCents(inputTokens: number, outputTokens: number): number {
  // Gemini 2.5 Flash: $0.075 / 1M input, $0.30 / 1M output
  const usd = (inputTokens * 0.075 + outputTokens * 0.3) / 1_000_000;
  return Math.ceil(usd * 100);
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `Du klassifizierst Outdoor-Gear-Items in EXAKT eine ProductType-Kategorie aus einer vorgegebenen Liste.

Aufgabe: Fuer jedes Input-Item entscheide, welcher der gelisteten ProductType-Namen am besten passt — basierend auf brand, name, description und category_legacy.

CRITICAL RULES:
(1) suggested_type_name MUSS ein name aus der candidates-Liste sein, NIEMALS erfunden. Wenn keine Kategorie passt → suggested_type_name=null, confidence=0.
(2) confidence-Skala (KONSERVATIV — bei Unsicherheit niedriger waehlen):
    1.0   = name enthaelt den Kategorie-Namen explizit ("UL Daypack 25L" → Daypack)
    0.85-0.95 = klare semantische Zuordnung (Brand+Description macht Type eindeutig)
    0.7-0.85  = plausibel, aber name allein nicht eindeutig
    <0.7  = unsicher → wird vom Caller verworfen
(3) Wenn category_legacy einen klaren Hint gibt ("tents" → Tent-Kategorie), nutze ihn — aber NUR wenn er zu einer canonical-Kategorie matched.
(4) Bei mehrdeutigen Namen ("Foo 3000 Pro", "Generic Widget Mk II") → confidence < 0.7 setzen, Reasoning warum unsicher.
(5) Brand allein darf NIE zur Klassifikation reichen ("Patagonia" → kann fast alles sein).
(6) reasoning kurz halten (max 200 Zeichen).

Antworte AUSSCHLIESSLICH im JSON-Format:
{
  "results": [
    {"memgraph_id": "<id>", "suggested_type_name": "<name|null>", "confidence": 0.0..1.0, "reasoning": "<≤200 chars>"},
    ...
  ]
}
Keine Markdown-Fences, keine Erklaerungen ausserhalb des JSON.`;

function buildUserPrompt(
  items: GearItemForClassification[],
  candidates: ProductTypeCandidate[],
): string {
  const lines: string[] = [];
  lines.push(
    `Klassifiziere die folgenden ${items.length} gear_items in genau eine der ${candidates.length} candidate-ProductTypes.\n`,
  );
  lines.push(`CANDIDATES (${candidates.length}):`);
  for (const c of candidates) {
    const desc = c.description
      ? ` — ${c.description.slice(0, 80).replace(/"/g, "'")}`
      : "";
    lines.push(`- "${c.name}"${desc}`);
  }
  lines.push("");
  lines.push(`ITEMS (${items.length}):`);
  for (const it of items) {
    const parts = [
      `id=${it.memgraph_id}`,
      `brand="${it.brand}"`,
      `name="${it.name}"`,
    ];
    if (it.category_legacy) {
      parts.push(`category_legacy="${it.category_legacy}"`);
    }
    if (it.description) {
      parts.push(
        `description="${it.description.slice(0, 200).replace(/"/g, "'")}"`,
      );
    }
    lines.push(`- ${parts.join(" ")}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// JSON parse cascade (same as tip-classifier / auto-typing)
// ---------------------------------------------------------------------------

function tryExtractFencedJson(raw: string): string | null {
  const closed = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n```/i);
  if (closed?.[1]) return closed[1];
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
      `[memgraph-product-type-classifier] LLM response was not valid JSON: ${content.slice(0, 500)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// HTTP shapes
// ---------------------------------------------------------------------------

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
// Public API
// ---------------------------------------------------------------------------

export interface ClassifyBatchResult {
  results: ProductTypeClassificationResult[];
  cost_cents: number;
  input_tokens: number;
  output_tokens: number;
}

/**
 * Classify a batch of GearItems against candidate ProductType names.
 * Single Gemini call returns N classifications.
 * Recommended batch size: 30.
 */
export async function classifyProductTypeBatch(
  items: GearItemForClassification[],
  candidates: ProductTypeCandidate[],
): Promise<ClassifyBatchResult> {
  if (items.length === 0) {
    return { results: [], cost_cents: 0, input_tokens: 0, output_tokens: 0 };
  }
  if (candidates.length === 0) {
    throw new Error(
      "[memgraph-product-type-classifier] candidates list is empty",
    );
  }

  const apiKey = process.env.AI_GATEWAY_API_KEY;
  if (!apiKey) {
    throw new Error(
      "AI_GATEWAY_API_KEY env var is required for memgraph product type classifier",
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
      { role: "user" as const, content: buildUserPrompt(items, candidates) },
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
      `[memgraph-product-type-classifier] gateway HTTP ${res.status}: ${errText.slice(0, 500)}`,
    );
  }

  const json = (await res.json()) as OpenAIChatResponse;
  const content = json.choices[0]?.message?.content;
  if (!content) {
    throw new Error(
      `[memgraph-product-type-classifier] empty response: ${JSON.stringify(json).slice(0, 300)}`,
    );
  }

  // DEBUG: log first chars of response to diagnose 'classified=0' bug
  console.log(
    `[memgraph-product-type-classifier] DEBUG response (items=${items.length}): ${content.slice(0, 800).replace(/\n/g, " ")}`,
  );

  const parsed = parseJsonResponse(content);
  // LLM sometimes returns the bare results array; accept both.
  const wrapped = Array.isArray(parsed) ? { results: parsed } : parsed;
  const validated = LLMResponseSchema.parse(wrapped);

  const usage = json.usage ?? {};
  const inputTokens = usage.prompt_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? 0;
  const cost = costCents(inputTokens, outputTokens);

  // Hallucination-guard: drop suggestions whose suggested_type_name is not in
  // the candidate name-set. Also drop unknown memgraph_ids.
  const candidateNameSet = new Set(candidates.map((c) => c.name));
  const itemIdSet = new Set(items.map((it) => it.memgraph_id));
  let halluCount = 0;
  let unknownItemCount = 0;
  const cleaned: ProductTypeClassificationResult[] = [];
  for (const r of validated.results) {
    if (!itemIdSet.has(r.memgraph_id)) {
      unknownItemCount += 1;
      continue;
    }
    if (
      r.suggested_type_name !== null &&
      !candidateNameSet.has(r.suggested_type_name)
    ) {
      halluCount += 1;
      cleaned.push({
        memgraph_id: r.memgraph_id,
        suggested_type_name: null,
        confidence: 0,
        reasoning: `hallucination_guard: suggested name "${r.suggested_type_name}" not in candidates (orig: ${r.reasoning.slice(0, 100)})`,
      });
      continue;
    }
    cleaned.push({
      memgraph_id: r.memgraph_id,
      suggested_type_name: r.suggested_type_name,
      confidence: r.confidence,
      reasoning: r.reasoning,
    });
  }

  if (halluCount > 0) {
    console.warn(
      `[memgraph-product-type-classifier] hallucination-guard rewrote ${halluCount} suggestions to null`,
    );
  }
  if (unknownItemCount > 0) {
    console.warn(
      `[memgraph-product-type-classifier] ${unknownItemCount} LLM results referenced unknown memgraph_ids — dropped`,
    );
  }

  return {
    results: cleaned,
    cost_cents: cost,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
  };
}
