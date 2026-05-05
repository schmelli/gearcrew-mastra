/**
 * Brand-Clustering Library — Phase 09 / DATA-02 (GEA-1083)
 *
 * Calls Vercel AI Gateway (OpenAI-compatible HTTP endpoint) with structured
 * JSON output to cluster outdoor-gear brand names that are casing/hyphen/suffix
 * variants of the same real-world brand into canonical-candidate groups for
 * human admin review.
 *
 * We use the gateway's OpenAI-compatible API directly via fetch (NOT the
 * @ai-sdk/gateway SDK) because the gardener's `ai` is v4 (LanguageModelV1)
 * while @ai-sdk/gateway returns LanguageModelV2 — version mismatch. Direct
 * HTTP keeps us decoupled from SDK version churn.
 *
 * Cost-cap (hard abort): default model is `google/gemini-2.5-flash` (cheap +
 * deterministic). Pre-call estimator + post-call actual cost — both compared
 * against `opts.maxCostCents` ($10 = 1000 cents per CONTEXT D-15).
 */

import { z } from "zod";
import { randomUUID } from "node:crypto";
import { zodToJsonSchema } from "zod-to-json-schema";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const BrandSnapshotSchema = z.object({
  brands: z.array(
    z.object({
      name: z.string(),
      normalized_name: z.string().optional(),
      item_count: z.number().optional(),
      source: z.string().optional(),
    }),
  ),
});

export type BrandSnapshot = z.infer<typeof BrandSnapshotSchema>;

const BrandAliasSchema = z.object({
  name: z.string(),
  item_count: z.number().optional(),
  country_hint: z.string().optional(),
});

const BrandClusterLLMSchema = z.object({
  canonical_candidate: z.string(),
  aliases: z.array(BrandAliasSchema).min(1),
  llm_confidence: z.number().min(0).max(1),
  llm_reasoning: z.string(),
});

export const BrandClusterSchema = BrandClusterLLMSchema.extend({
  cluster_id: z.string().uuid(),
});

export type BrandClusterProposal = z.infer<typeof BrandClusterSchema>;

const LLMResponseSchema = z.object({
  clusters: z.array(BrandClusterLLMSchema).min(1),
});

// ---------------------------------------------------------------------------
// Pricing — defaults match Gemini 2.5 Flash list price (USD).
// Override with env vars BRAND_DEDUP_INPUT_PRICE_CENTS_PER_1M and
// BRAND_DEDUP_OUTPUT_PRICE_CENTS_PER_1M to recalibrate after first real run.
// ---------------------------------------------------------------------------

const DEFAULT_INPUT_PRICE_CENTS_PER_1M = 7.5; // $0.075 / 1M tokens
const DEFAULT_OUTPUT_PRICE_CENTS_PER_1M = 30; // $0.30  / 1M tokens
const TOKEN_ESTIMATE_PER_BRAND = 50;
const ESTIMATE_OUTPUT_MULTIPLIER = 3;

function inputPriceCentsPerMillion(): number {
  const fromEnv = process.env.BRAND_DEDUP_INPUT_PRICE_CENTS_PER_1M;
  return fromEnv ? parseFloat(fromEnv) : DEFAULT_INPUT_PRICE_CENTS_PER_1M;
}

function outputPriceCentsPerMillion(): number {
  const fromEnv = process.env.BRAND_DEDUP_OUTPUT_PRICE_CENTS_PER_1M;
  return fromEnv ? parseFloat(fromEnv) : DEFAULT_OUTPUT_PRICE_CENTS_PER_1M;
}

function costCents(inputTokens: number, outputTokens: number): number {
  const inputCost = (inputTokens / 1_000_000) * inputPriceCentsPerMillion();
  const outputCost = (outputTokens / 1_000_000) * outputPriceCentsPerMillion();
  return Math.ceil(inputCost + outputCost);
}

// ---------------------------------------------------------------------------
// System prompt — strict deduplication rules to keep the LLM conservative.
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `Du clusterst outdoor-gear brand-Namen.
Aufgabe: Eingabe-Liste von Brand-Namen (mit item_counts) → Output: array of clusters where each cluster groups variants of the SAME real-world brand together.

CRITICAL RULES:
(1) Casing/Hyphen-Varianten ('Therm-a-Rest', 'Therm-A-Rest', 'Thermarest', 'therm a rest') sind IMMER ein Cluster, canonical = häufigste Schreibung mit höchstem item_count.
(2) Kompanie-Suffixe ('Black Diamond' vs 'Black Diamond Equipment') sind IMMER ein Cluster, canonical = die kürzere/marken-bekanntere Form.
(3) Geo-Suffixe ('Big Agnes' vs 'Big Agnes Europe') sind NICHT zu mergen wenn sie distinct legal entities sein KÖNNTEN — markiere mit niedriger confidence (≤0.6) statt aggressive zu mergen, ODER lasse sie als separate Solo-Cluster.
(4) llm_confidence-Skala:
    1.0   = identische Schreibung (Solo-Cluster, alias = self)
    0.95+ = casing/hyphen-only variants
    0.85+ = klare Suffix-Variante (Equipment, Outdoors, Co.)
    0.6-0.85 = plausibel aber unsicher
    <0.6  = besser separat
(5) Solo-brands (kein Duplicate gefunden) → eigener Cluster mit aliases=[selbst] (single-element), confidence=1.0, reasoning='no variants detected'.
(6) Output muss ALLE Input-brands abdecken (jede brand in genau einem cluster). Wenn unsicher → eigener Solo-Cluster.

Antworte AUSSCHLIESSLICH im JSON-Format mit der vorgegebenen Struktur. Keine zusätzlichen Felder, keine Erklärungen ausserhalb von llm_reasoning.`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ClusterBrandsOptions {
  maxCostCents: number;
  modelIdOverride?: string;
}

export interface ClusterBrandsResult {
  clusters: BrandClusterProposal[];
  cost_cents_used: number;
  estimated_cost_cents: number;
  aborted_due_to_cost: boolean;
}

function resolveModelId(override?: string): `${string}/${string}` {
  const raw = override ?? process.env.BRAND_DEDUP_MODEL_ID ?? "google/gemini-2.5-flash";
  if (!raw.includes("/")) {
    throw new Error(
      `BRAND_DEDUP_MODEL_ID must be a "<provider>/<model>" string, got: ${raw}`,
    );
  }
  return raw as `${string}/${string}`;
}

function estimateCostCents(brandCount: number): number {
  const estInput = brandCount * TOKEN_ESTIMATE_PER_BRAND;
  const estOutput = estInput * ESTIMATE_OUTPUT_MULTIPLIER;
  return costCents(estInput, estOutput);
}

function buildUserPrompt(snapshot: BrandSnapshot): string {
  const lines = snapshot.brands.map((b) => {
    const count = b.item_count ?? 0;
    return `- ${b.name} (item_count=${count})`;
  });
  return `Cluster die folgenden ${snapshot.brands.length} brand-Namen. Output: JSON object { "clusters": [...] } mit canonical_candidate, aliases (mind. 1, jede mit name + item_count + optional country_hint), llm_confidence, llm_reasoning.

${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// HTTP shapes for the Vercel AI Gateway OpenAI-compatible endpoint
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

function tryExtractFencedJson(raw: string): string | null {
  // Match closed fences first.
  const closed = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (closed && closed[1]) return closed[1].trim();
  // Fallback: opening fence only (response truncated by max_tokens).
  const opening = raw.match(/```(?:json)?\s*([\s\S]*)$/);
  if (opening && opening[1]) return opening[1].trim();
  return null;
}

/**
 * Slice the input to the largest balanced { ... } JSON object substring.
 * Returns the substring or null if no balanced object is found.
 */
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

/**
 * Best-effort repair of truncated JSON by closing unbalanced brackets/braces.
 * Handles the Gemini-via-gateway case where max_tokens cuts off the response
 * mid-array. Drops trailing partial entries until balance is restored.
 */
function repairTruncatedJson(raw: string): string | null {
  let depth = 0;
  const stack: string[] = [];
  let inString = false;
  let escape = false;
  let lastSafePoint = -1;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{" || ch === "[") {
      stack.push(ch === "{" ? "}" : "]");
      depth = stack.length;
    } else if (ch === "}" || ch === "]") {
      stack.pop();
      depth = stack.length;
      if (depth === 0) return raw.slice(0, i + 1);
    } else if (ch === "," && depth <= 2) {
      // Comma at depth 1 or 2 = end of a top-level entry; safe truncation point.
      lastSafePoint = i;
    }
  }

  if (lastSafePoint === -1) return null;
  // Truncate at last safe comma + close all remaining open brackets/braces.
  const head = raw.slice(0, lastSafePoint);
  const closers = stack.reverse().join("");
  return head + closers;
}

function parseJsonResponse(content: string): unknown {
  // Try direct JSON.parse first (works when response_format=json_object).
  try {
    return JSON.parse(content);
  } catch {
    // Fenced block (closed or opening-only).
    const fenced = tryExtractFencedJson(content);
    if (fenced) {
      try {
        return JSON.parse(fenced);
      } catch {
        // Fall through to balanced + repair extraction.
      }
    }
    // Balanced { ... } extraction (handles trailing prose or truncated fences).
    const balanced = extractBalancedJsonObject(content);
    if (balanced) {
      try {
        return JSON.parse(balanced);
      } catch {
        // Fall through to truncation-repair.
      }
    }
    // Last resort: repair truncated JSON by closing unbalanced brackets.
    const candidate = fenced ?? content;
    const repaired = repairTruncatedJson(candidate);
    if (repaired) {
      try {
        const parsed = JSON.parse(repaired) as unknown;
        console.warn(
          `[brand-clustering] LLM response was truncated; recovered ${repaired.length}/${candidate.length} chars via best-effort repair.`,
        );
        return parsed;
      } catch {
        // Fall through to throw.
      }
    }
    throw new Error(
      `[brand-clustering] LLM response was not valid JSON: ${content.slice(0, 500)}...`,
    );
  }
}

/**
 * Cluster outdoor-gear brand names via Vercel AI Gateway (OpenAI-compatible
 * chat/completions endpoint) with `response_format: { type: 'json_object' }`.
 *
 * Flow:
 *   1. Estimate cost (`brands.length * 50 * 4 tokens`). Abort BEFORE the LLM
 *      call if estimate exceeds maxCostCents.
 *   2. POST chat completion with strict JSON output instruction.
 *   3. Parse + validate with Zod.
 *   4. Compute actual cost from usage. If actual exceeds maxCostCents, return
 *      clusters but flag aborted_due_to_cost=true so the workflow can pause
 *      writes and surface for review.
 */
export async function clusterBrands(
  snapshot: BrandSnapshot,
  opts: ClusterBrandsOptions,
): Promise<ClusterBrandsResult> {
  const validated = BrandSnapshotSchema.parse(snapshot);
  const brandCount = validated.brands.length;
  const estimated_cost_cents = estimateCostCents(brandCount);

  if (estimated_cost_cents > opts.maxCostCents) {
    console.warn(
      `[brand-clustering] PRE-CALL ABORT — estimated ${estimated_cost_cents}¢ exceeds cap ${opts.maxCostCents}¢ (brands=${brandCount})`,
    );
    return {
      clusters: [],
      cost_cents_used: 0,
      estimated_cost_cents,
      aborted_due_to_cost: true,
    };
  }

  const modelId = resolveModelId(opts.modelIdOverride);
  const apiKey = process.env.AI_GATEWAY_API_KEY;
  if (!apiKey) {
    throw new Error("AI_GATEWAY_API_KEY env var is required for brand-clustering");
  }
  // Vercel AI Gateway exposes its OpenAI-compatible chat endpoint under
  // /v1/chat/completions (NOT /v1/ai/chat/completions — that path is reserved
  // for the AI-SDK protocol). The repo's existing AI_GATEWAY_BASE_URL env var
  // points at /v1/ai for SDK use, so we normalise to /v1 for raw chat calls.
  const rawBaseUrl = process.env.AI_GATEWAY_BASE_URL ?? "https://ai-gateway.vercel.sh/v1";
  const trimmed = rawBaseUrl.replace(/\/$/, "").replace(/\/ai$/, "");
  const endpoint = `${trimmed}/chat/completions`;

  console.log(
    `[brand-clustering] calling ${modelId} via ${endpoint} — ${brandCount} brands, estimated ${estimated_cost_cents}¢ (cap ${opts.maxCostCents}¢)`,
  );

  // Pass a JSON-schema hint inline for models that benefit from it (Gemini does).
  const schemaHint = JSON.stringify(zodToJsonSchema(LLMResponseSchema), null, 2);

  // NOTE: Vercel AI Gateway routes to Vertex/Gemini for google/gemini-* models
  // and Vertex rejects `response_format: { type: 'json_object' }` (returns
  // 400 invalid_request_error). We rely on prompt-only JSON instruction and
  // robust JSON extraction in parseJsonResponse() instead.
  //
  // Gemini 2.5 Flash uses "thinking tokens" that count against max_tokens but
  // are not visible in the response. For 61 brands → ~60 clusters output JSON
  // (~6KB), set max_tokens generously to avoid silent truncation. 32k covers
  // the worst case where the model thinks heavily.
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
  // For OpenAI/Anthropic models the Vercel gateway accepts response_format —
  // include it conditionally to harden parsing for those providers.
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
      `[brand-clustering] gateway HTTP ${res.status}: ${errText.slice(0, 500)}`,
    );
  }

  const json = (await res.json()) as OpenAIChatResponse;
  const content = json.choices[0]?.message?.content;
  if (!content) {
    throw new Error(
      `[brand-clustering] empty response from ${modelId}: ${JSON.stringify(json).slice(0, 300)}`,
    );
  }

  const parsed = parseJsonResponse(content);
  const validatedResponse = LLMResponseSchema.parse(parsed);

  const usage = json.usage ?? {};
  const inputTokens = usage.prompt_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? 0;
  const actualCost = costCents(inputTokens, outputTokens);

  // Attach workflow-side UUIDs.
  const clusters: BrandClusterProposal[] = validatedResponse.clusters.map((c) => ({
    ...c,
    cluster_id: randomUUID(),
  }));

  const aborted_due_to_cost = actualCost > opts.maxCostCents;
  if (aborted_due_to_cost) {
    console.warn(
      `[brand-clustering] POST-CALL OVERAGE — actual ${actualCost}¢ exceeds cap ${opts.maxCostCents}¢ (in=${inputTokens}, out=${outputTokens})`,
    );
  } else {
    console.log(
      `[brand-clustering] OK — ${clusters.length} clusters, ${actualCost}¢ used (in=${inputTokens}, out=${outputTokens})`,
    );
  }

  // Soft-validate coverage: warn if not every input brand appears in some cluster.
  const allAliasNames = new Set(
    clusters.flatMap((c) => c.aliases.map((a) => a.name.toLowerCase())),
  );
  const missing = validated.brands.filter(
    (b) => !allAliasNames.has(b.name.toLowerCase()),
  );
  if (missing.length > 0) {
    console.warn(
      `[brand-clustering] coverage warning — ${missing.length} input brands not in any cluster: ${missing
        .slice(0, 5)
        .map((b) => b.name)
        .join(", ")}${missing.length > 5 ? ", ..." : ""}`,
    );
  }

  return {
    clusters,
    cost_cents_used: actualCost,
    estimated_cost_cents,
    aborted_due_to_cost,
  };
}
