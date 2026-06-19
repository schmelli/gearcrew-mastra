/**
 * LLM Structured Extraction for Background Enrichment — Gardener Copy
 * Phase 27 — ARCH-01: Migrated from winterberry lib/enrichment/llm-extraction.ts
 *
 * Gardener-native AI call: raw fetch against AI_GATEWAY_BASE_URL/chat/completions
 * (NO 'ai' package — not installed in gardener).
 * Returns all-null result on any error — never throws.
 *
 * UI-status-only write: this module does NOT write enrichment_status.
 * Supabase writes (enrichment_ui_state only) happen in enrich-gear-item.ts.
 */

import { z } from "zod";

// =============================================================================
// Schema (ported from winterberry — identical shape)
// =============================================================================

export const EnrichmentSchema = z.object({
  brand: z.string().nullable(),
  description: z.string().nullable(),
  weightGrams: z.number().nullable(),
  materials: z.string().nullable(),
  modelNumber: z.string().nullable(),
  size: z.string().nullable(),
  color: z.string().nullable(),
});

export type LlmEnrichmentResult = z.infer<typeof EnrichmentSchema>;

// =============================================================================
// Constants
// =============================================================================

const MODEL_ID = "anthropic/claude-haiku-4-5";
const TIMEOUT_MS = 15_000;

const SYSTEM_PROMPT = `You are an outdoor gear data extraction assistant. Extract structured product data from the provided search context. Only return values you are confident about. Return null for uncertain fields. Weight must be in grams. Description should be 1-2 sentences about the product's key features.`;

// =============================================================================
// Null result (returned on failure)
// =============================================================================

const NULL_RESULT: LlmEnrichmentResult = {
  brand: null,
  description: null,
  weightGrams: null,
  materials: null,
  modelNumber: null,
  size: null,
  color: null,
};

// =============================================================================
// OpenAI-compatible response type (raw fetch)
// =============================================================================

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

// =============================================================================
// JSON parse helpers (copied from gardener/src/lib/enrichment-extractors.ts)
// =============================================================================

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
      `[enrichment] LLM response was not valid JSON: ${content.slice(0, 500)}`,
    );
  }
}

// =============================================================================
// Prompt Builder
// =============================================================================

function buildUserPrompt(context: ExtractionContext): string {
  const lines: string[] = [];

  lines.push(`Product: ${context.name}`);
  if (context.brand) {
    lines.push(`Known brand: ${context.brand}`);
  }
  if (context.category) {
    lines.push(`Category: ${context.category}`);
  }

  if (Object.keys(context.knowledgeGraphAttributes).length > 0) {
    lines.push("");
    lines.push("Knowledge Graph attributes:");
    for (const [key, value] of Object.entries(context.knowledgeGraphAttributes)) {
      lines.push(`  ${key}: ${value}`);
    }
  }

  if (context.searchSnippets.length > 0) {
    lines.push("");
    lines.push("Search snippets:");
    for (const snippet of context.searchSnippets) {
      lines.push(`- ${snippet}`);
    }
  }

  return lines.join("\n");
}

// =============================================================================
// Public API
// =============================================================================

export interface ExtractionContext {
  name: string;
  brand: string | null;
  category: string | null;
  searchSnippets: string[];
  knowledgeGraphAttributes: Record<string, string>;
}

/**
 * Extract structured product data from search context using Haiku 4.5.
 *
 * Gardener-native: raw fetch against AI_GATEWAY_BASE_URL/chat/completions.
 * No 'ai' package. Returns all-null result on any failure. Never throws.
 *
 * T-27-09: API key is read only from gardener .env — never echoed in response.
 */
export async function extractWithLlm(
  context: ExtractionContext,
): Promise<LlmEnrichmentResult> {
  const apiKey = process.env.AI_GATEWAY_API_KEY;
  if (!apiKey) {
    console.warn("[llm-extraction] AI_GATEWAY_API_KEY not set, skipping LLM extraction");
    return NULL_RESULT;
  }

  const rawBaseUrl =
    process.env.AI_GATEWAY_BASE_URL ?? "https://ai-gateway.vercel.sh/v1";
  const trimmed = rawBaseUrl.replace(/\/$/, "").replace(/\/ai$/, "");
  const endpoint = `${trimmed}/chat/completions`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: MODEL_ID,
          temperature: 0,
          max_tokens: 1024,
          messages: [
            { role: "system" as const, content: SYSTEM_PROMPT },
            { role: "user" as const, content: buildUserPrompt(context) },
          ],
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!res.ok) {
      const errText = await res.text();
      console.error(
        `[llm-extraction] gateway HTTP ${res.status}: ${errText.slice(0, 500)}`,
      );
      return NULL_RESULT;
    }

    const json = (await res.json()) as OpenAIChatResponse;
    const content = json.choices[0]?.message?.content;
    if (!content) {
      console.error(
        `[llm-extraction] empty response: ${JSON.stringify(json).slice(0, 300)}`,
      );
      return NULL_RESULT;
    }

    const parsed = parseJsonResponse(content);
    const validated = EnrichmentSchema.parse(parsed);

    console.log(`[llm-extraction] extraction succeeded for: ${context.name}`);
    return validated;
  } catch (error) {
    console.error(
      "[llm-extraction] extraction failed, returning null result",
      { product: context.name },
      error instanceof Error ? error.message : String(error),
    );
    return NULL_RESULT;
  }
}
