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
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced && fenced[1]) return fenced[1].trim();
  return null;
}

function parseJsonResponse(content: string): unknown {
  // Try direct JSON.parse first (response_format=json_object guarantees
  // valid JSON in spec), then fall back to fenced-block extraction.
  try {
    return JSON.parse(content);
  } catch {
    const fenced = tryExtractFencedJson(content);
    if (fenced) {
      return JSON.parse(fenced);
    }
    throw new Error(
      `[brand-clustering] LLM response was not valid JSON: ${content.slice(0, 200)}...`,
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
  const baseUrl = process.env.AI_GATEWAY_BASE_URL ?? "https://ai-gateway.vercel.sh/v1/ai";
  const endpoint = `${baseUrl.replace(/\/$/, "")}/chat/completions`;

  console.log(
    `[brand-clustering] calling ${modelId} via ${endpoint} — ${brandCount} brands, estimated ${estimated_cost_cents}¢ (cap ${opts.maxCostCents}¢)`,
  );

  // Pass a JSON-schema hint inline for models that benefit from it (Gemini does).
  const schemaHint = JSON.stringify(zodToJsonSchema(LLMResponseSchema), null, 2);

  const requestBody = {
    model: modelId,
    temperature: 0,
    response_format: { type: "json_object" as const },
    messages: [
      {
        role: "system" as const,
        content: `${SYSTEM_PROMPT}\n\nReturn JSON exactly matching this schema (do not include the schema in your output, only the matching JSON object):\n\`\`\`json\n${schemaHint}\n\`\`\``,
      },
      { role: "user" as const, content: buildUserPrompt(validated) },
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
