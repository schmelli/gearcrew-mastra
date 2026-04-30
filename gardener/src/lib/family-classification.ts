/**
 * Family-Classification Library — Quick-Task 260430-fam
 *
 * Reads :ProductFamily nodes from Memgraph (with their variant counts +
 * variant brands), then asks the Vercel AI Gateway to classify each as
 * `genuine` (real manufacturer line like "Hilleberg Nallo", "Big Agnes
 * Copper Spur") or `generic` (category umbrella like "Backpacks", "Sleeping
 * Mats", "Down Jackets") with a third `ambiguous` bucket for human review.
 *
 * Pattern bewusst angelehnt an brand-clustering.ts:
 *  - Direct fetch to /v1/chat/completions (NOT @ai-sdk/gateway — version churn)
 *  - Pre-call cost estimator + post-call actual cost, both vs maxCostCents
 *  - Robust JSON parsing (fenced blocks, balanced extraction, raw)
 *  - Gemini-2.5-Flash default; OpenAI-compatible models keep response_format
 *
 * Apply-side semantics:
 *  - genuine → SET f.canonical_name + f.brand_id + f.brand_name on Memgraph
 *  - generic → DETACH DELETE the :ProductFamily node + all IS_VARIANT_OF edges
 *  - ambiguous → no graph mutation, requires admin decision
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const FamilyVariantBrandSchema = z.object({
  name: z.string(),
  count: z.number(),
});

export const FamilySnapshotEntrySchema = z.object({
  family_node_id: z.string(),
  family_name: z.string(),
  variant_count: z.number(),
  variant_brands: z.array(FamilyVariantBrandSchema),
  product_types: z.array(z.string()),
});

export const FamilySnapshotSchema = z.object({
  families: z.array(FamilySnapshotEntrySchema),
});

export type FamilySnapshot = z.infer<typeof FamilySnapshotSchema>;
export type FamilySnapshotEntry = z.infer<typeof FamilySnapshotEntrySchema>;

const ClassificationEnum = z.enum(["genuine", "generic", "ambiguous"]);

const FamilyClassificationLLMSchema = z.object({
  family_node_id: z.string(),
  classification: ClassificationEnum,
  proposed_canonical_name: z.string().nullable(),
  proposed_brand_name: z.string().nullable(),
  llm_confidence: z.number().min(0).max(1),
  llm_reasoning: z.string(),
});

export type FamilyClassificationProposal = z.infer<typeof FamilyClassificationLLMSchema>;

const LLMResponseSchema = z.object({
  classifications: z.array(FamilyClassificationLLMSchema).min(1),
});

// ---------------------------------------------------------------------------
// Pricing — Gemini 2.5 Flash defaults, override via env vars
// ---------------------------------------------------------------------------

const DEFAULT_INPUT_PRICE_CENTS_PER_1M = 7.5;
const DEFAULT_OUTPUT_PRICE_CENTS_PER_1M = 30;
const TOKEN_ESTIMATE_PER_FAMILY = 80;
const ESTIMATE_OUTPUT_MULTIPLIER = 3;

function inputPriceCentsPerMillion(): number {
  const fromEnv = process.env.FAMILY_CANONICAL_INPUT_PRICE_CENTS_PER_1M;
  return fromEnv ? parseFloat(fromEnv) : DEFAULT_INPUT_PRICE_CENTS_PER_1M;
}

function outputPriceCentsPerMillion(): number {
  const fromEnv = process.env.FAMILY_CANONICAL_OUTPUT_PRICE_CENTS_PER_1M;
  return fromEnv ? parseFloat(fromEnv) : DEFAULT_OUTPUT_PRICE_CENTS_PER_1M;
}

function costCents(inputTokens: number, outputTokens: number): number {
  const inputCost = (inputTokens / 1_000_000) * inputPriceCentsPerMillion();
  const outputCost = (outputTokens / 1_000_000) * outputPriceCentsPerMillion();
  return Math.ceil(inputCost + outputCost);
}

// ---------------------------------------------------------------------------
// System prompt — strict classification rules
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `Du klassifizierst :ProductFamily-Knoten aus einem Outdoor-Gear-Katalog.

DEFINITION ProductFamily:
- "genuine" = echte Hersteller-Produktlinie wie "Hilleberg Nallo", "Fjällräven Kajka", "Big Agnes Copper Spur", "Therm-a-Rest NeoAir", "NEMO Tensor"
- "generic" = Kategorie-Sammelbegriff wie "Backpacks", "Sleeping Mats", "Down Jackets", "2-Person Tents" — das sind ProductTypes, nicht Familien
- "ambiguous" = unklar oder Grenzfall

CRITICAL RULES für Klassifikation:

(1) genuine-Signale (alle erhöhen Confidence):
   - Familienname enthält Modell-Suffix wie "Series", "Pro", "UL", "HV", "Lite", "X", numerische Suffixe
   - ALLE Variants stammen vom selben Brand
   - Variants haben sehr ähnliche Namen mit Saison-/Größen-/Farb-Variation
   - Familienname ist KEIN gängiger ProductType-Name

(2) generic-Signale (jedes EINZELNE reicht für generic-Klassifikation):
   - Familienname ist ein gängiger ProductType-Name ("Backpacks", "Tents", "Sleeping Mats", "Down Jackets", "Stoves", "Quilts")
   - Variants stammen von MEHREREN verschiedenen Brands (>1 distinct brand)
   - Familienname enthält generische Plural-Wörter ohne Hersteller-Spezifik
   - Familienname matcht 1:1 einen Eintrag in product_types

(3) ambiguous-Signale (wenn nicht klar genuine/generic):
   - Familienname enthält Brand + Kategorie ("Cumulus Quilts", "Hilleberg Tents") — könnte echte interne Brand-Kategorie sein oder generische Sammlung
   - Mehrdeutiger Name ("Astro Pro" — könnte eine Modell-Linie sein, könnte aber auch Marketing-Suffix mehrerer Linien sein)

(4) proposed_canonical_name (NUR für genuine, sonst null):
   - Wenn ALLE Variants vom selben Brand stammen → "{Brand} {Family}", z.B. "Hilleberg Nallo", "NEMO Tensor Series"
   - Wenn Family-Name den Brand bereits enthält → den Family-Namen unverändert lassen
   - Bei generic/ambiguous → null

(5) proposed_brand_name (NUR für genuine wenn ALLE Variants gleichen Brand teilen):
   - Wenn variant_brands hat genau 1 Eintrag → diesen Brand-Namen
   - Wenn variant_brands hat >1 Brand → null (kein eindeutiger Brand)
   - Bei generic/ambiguous → null

(6) llm_confidence-Skala:
   1.0   = absolut eindeutig (z.B. "Hilleberg Nallo" mit allen Variants von Hilleberg)
   0.85+ = klar entscheidbar mit allen Signalen ausgerichtet
   0.7-0.85 = klar aber mit kleineren Signalen die in andere Richtung deuten
   0.5-0.7 = unsicher → nutze "ambiguous"
   <0.5 = sehr unsicher → "ambiguous"

(7) Output muss ALLE Eingabe-Familien abdecken (jede family_node_id GENAU EINMAL).

Antworte AUSSCHLIESSLICH im JSON-Format mit der vorgegebenen Struktur. Keine zusätzlichen Felder, keine Erklärungen ausserhalb von llm_reasoning.`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ClassifyFamiliesOptions {
  maxCostCents: number;
  modelIdOverride?: string;
}

export interface ClassifyFamiliesResult {
  proposals: FamilyClassificationProposal[];
  cost_cents_used: number;
  estimated_cost_cents: number;
  aborted_due_to_cost: boolean;
}

function resolveModelId(override?: string): `${string}/${string}` {
  const raw =
    override ?? process.env.FAMILY_CANONICAL_MODEL_ID ?? "google/gemini-2.5-flash";
  if (!raw.includes("/")) {
    throw new Error(
      `FAMILY_CANONICAL_MODEL_ID must be a "<provider>/<model>" string, got: ${raw}`,
    );
  }
  return raw as `${string}/${string}`;
}

function estimateCostCents(familyCount: number): number {
  const estInput = familyCount * TOKEN_ESTIMATE_PER_FAMILY;
  const estOutput = estInput * ESTIMATE_OUTPUT_MULTIPLIER;
  return costCents(estInput, estOutput);
}

function buildUserPrompt(snapshot: FamilySnapshot): string {
  const lines = snapshot.families.map((f) => {
    const brands = f.variant_brands
      .map((b) => `${b.name}(${b.count})`)
      .join(", ");
    const types = f.product_types.length > 0 ? f.product_types.join(", ") : "(none)";
    return `- node_id=${f.family_node_id} name="${f.family_name}" variants=${f.variant_count} brands=[${brands}] types=[${types}]`;
  });
  return `Klassifiziere die folgenden ${snapshot.families.length} ProductFamily-Knoten. Output: JSON-Object { "classifications": [...] } mit family_node_id, classification (genuine|generic|ambiguous), proposed_canonical_name (string|null), proposed_brand_name (string|null), llm_confidence (0..1), llm_reasoning (string).

${lines.join("\n")}`;
}

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
      `[family-classification] LLM response was not valid JSON: ${content.slice(0, 500)}...`,
    );
  }
}

// Default batch size: keeps Gemini Flash output well under the 32k max_tokens
// limit. First production run with batchSize=100 produced ~24k output tokens
// per batch and hit silent truncation in 3 of 7 batches — Gemini's hidden
// thinking-tokens budget eats more than expected. Reducing to 50 → ~7k output
// tokens per batch, leaves comfortable headroom even on heavy reasoning runs.
// Override via FAMILY_CANONICAL_BATCH_SIZE env var.
const DEFAULT_BATCH_SIZE = 50;

function resolveBatchSize(): number {
  const fromEnv = process.env.FAMILY_CANONICAL_BATCH_SIZE;
  if (!fromEnv) return DEFAULT_BATCH_SIZE;
  const n = parseInt(fromEnv, 10);
  if (Number.isNaN(n) || n <= 0) return DEFAULT_BATCH_SIZE;
  return n;
}

interface BatchClassifyResult {
  proposals: FamilyClassificationProposal[];
  input_tokens: number;
  output_tokens: number;
}

/**
 * Single LLM call for one batch of families. Throws on HTTP error or unparseable
 * response; caller decides whether to bail or continue with the next batch.
 */
async function classifyBatch(
  batch: FamilySnapshot,
  endpoint: string,
  apiKey: string,
  modelId: `${string}/${string}`,
  schemaHint: string,
): Promise<BatchClassifyResult> {
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
        content: `${SYSTEM_PROMPT}\n\nReturn JSON exactly matching this schema. Output ONLY the JSON object — no markdown fence, no explanation:\n\`\`\`json\n${schemaHint}\n\`\`\``,
      },
      { role: "user", content: buildUserPrompt(batch) },
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
      `[family-classification] gateway HTTP ${res.status}: ${errText.slice(0, 500)}`,
    );
  }

  const json = (await res.json()) as OpenAIChatResponse;
  const content = json.choices[0]?.message?.content;
  if (!content) {
    throw new Error(
      `[family-classification] empty response from ${modelId}: ${JSON.stringify(json).slice(0, 300)}`,
    );
  }

  const parsed = parseJsonResponse(content);
  const validatedResponse = LLMResponseSchema.parse(parsed);

  const usage = json.usage ?? {};
  return {
    proposals: validatedResponse.classifications,
    input_tokens: usage.prompt_tokens ?? 0,
    output_tokens: usage.completion_tokens ?? 0,
  };
}

/**
 * Classify ProductFamilies via Vercel AI Gateway. Mirrors clusterBrands()
 * shape so the workflow orchestration is symmetric.
 *
 * Flow:
 *   1. Pre-call cost estimate. Abort BEFORE LLM if estimate > maxCostCents.
 *   2. Split families into batches of FAMILY_CANONICAL_BATCH_SIZE (default 100)
 *      to stay under Gemini's 32k max_tokens output limit.
 *   3. Per batch: POST chat completion, parse, validate. Per-batch failures
 *      are logged and skipped (other batches continue).
 *   4. Aggregate proposals across batches. If cumulative cost exceeds
 *      maxCostCents, abort remaining batches and flag aborted_due_to_cost=true.
 */
export async function classifyFamilies(
  snapshot: FamilySnapshot,
  opts: ClassifyFamiliesOptions,
): Promise<ClassifyFamiliesResult> {
  const validated = FamilySnapshotSchema.parse(snapshot);
  const familyCount = validated.families.length;
  const estimated_cost_cents = estimateCostCents(familyCount);

  if (estimated_cost_cents > opts.maxCostCents) {
    console.warn(
      `[family-classification] PRE-CALL ABORT — estimated ${estimated_cost_cents}¢ exceeds cap ${opts.maxCostCents}¢ (families=${familyCount})`,
    );
    return {
      proposals: [],
      cost_cents_used: 0,
      estimated_cost_cents,
      aborted_due_to_cost: true,
    };
  }

  const modelId = resolveModelId(opts.modelIdOverride);
  const apiKey = process.env.AI_GATEWAY_API_KEY;
  if (!apiKey) {
    throw new Error(
      "AI_GATEWAY_API_KEY env var is required for family-classification",
    );
  }
  const rawBaseUrl =
    process.env.AI_GATEWAY_BASE_URL ?? "https://ai-gateway.vercel.sh/v1";
  const trimmed = rawBaseUrl.replace(/\/$/, "").replace(/\/ai$/, "");
  const endpoint = `${trimmed}/chat/completions`;

  const batchSize = resolveBatchSize();
  const totalBatches = Math.ceil(familyCount / batchSize);
  const schemaHint = JSON.stringify(zodToJsonSchema(LLMResponseSchema), null, 2);

  console.log(
    `[family-classification] calling ${modelId} via ${endpoint} — ${familyCount} families in ${totalBatches} batch(es) of up to ${batchSize}, estimated ${estimated_cost_cents}¢ (cap ${opts.maxCostCents}¢)`,
  );

  const allProposals: FamilyClassificationProposal[] = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let cumulativeCost = 0;
  let aborted_due_to_cost = false;
  const failedBatches: number[] = [];

  for (let batchIdx = 0; batchIdx < totalBatches; batchIdx += 1) {
    const start = batchIdx * batchSize;
    const end = Math.min(start + batchSize, familyCount);
    const batchSnapshot: FamilySnapshot = {
      families: validated.families.slice(start, end),
    };

    console.log(
      `[family-classification] batch ${batchIdx + 1}/${totalBatches}: classifying families ${start}-${end - 1} (${batchSnapshot.families.length} entries)`,
    );

    try {
      const batchResult = await classifyBatch(
        batchSnapshot,
        endpoint,
        apiKey,
        modelId,
        schemaHint,
      );
      allProposals.push(...batchResult.proposals);
      totalInputTokens += batchResult.input_tokens;
      totalOutputTokens += batchResult.output_tokens;
      cumulativeCost = costCents(totalInputTokens, totalOutputTokens);

      console.log(
        `[family-classification] batch ${batchIdx + 1}/${totalBatches} OK — ${batchResult.proposals.length} classifications, cumulative ${cumulativeCost}¢ (in=${totalInputTokens}, out=${totalOutputTokens})`,
      );

      if (cumulativeCost > opts.maxCostCents) {
        console.warn(
          `[family-classification] CUMULATIVE COST OVERAGE after batch ${batchIdx + 1} — ${cumulativeCost}¢ exceeds cap ${opts.maxCostCents}¢, aborting remaining ${totalBatches - batchIdx - 1} batch(es)`,
        );
        aborted_due_to_cost = true;
        break;
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(
        `[family-classification] batch ${batchIdx + 1}/${totalBatches} FAILED: ${reason.slice(0, 200)}`,
      );
      failedBatches.push(batchIdx + 1);
    }
  }

  if (failedBatches.length > 0) {
    console.warn(
      `[family-classification] ${failedBatches.length} batch(es) failed: ${failedBatches.join(", ")}`,
    );
  }

  // Coverage check
  const proposalIds = new Set(allProposals.map((p) => p.family_node_id));
  const missing = validated.families.filter(
    (f) => !proposalIds.has(f.family_node_id),
  );
  if (missing.length > 0) {
    console.warn(
      `[family-classification] coverage warning — ${missing.length} families not classified: ${missing
        .slice(0, 5)
        .map((f) => f.family_name)
        .join(", ")}${missing.length > 5 ? ", ..." : ""}`,
    );
  }

  // Distribution log
  const dist = allProposals.reduce<Record<string, number>>((acc, p) => {
    acc[p.classification] = (acc[p.classification] ?? 0) + 1;
    return acc;
  }, {});
  console.log(
    `[family-classification] FINAL: ${allProposals.length} classifications across ${totalBatches - failedBatches.length}/${totalBatches} successful batches, ${cumulativeCost}¢ used (in=${totalInputTokens}, out=${totalOutputTokens})`,
  );
  console.log(
    `[family-classification] distribution: genuine=${dist.genuine ?? 0}, generic=${dist.generic ?? 0}, ambiguous=${dist.ambiguous ?? 0}`,
  );

  return {
    proposals: allProposals,
    cost_cents_used: cumulativeCost,
    estimated_cost_cents,
    aborted_due_to_cost,
  };
}
