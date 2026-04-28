/**
 * Type-Clustering Library — Phase 09 / DATA-03 (GEA-1084)
 *
 * Clusters outdoor-gear ProductType-Namen (e.g. "Daypack", "Daypacks",
 * "Men's Daypack", "Women's Daypack") into canonical-candidate groups for
 * human-review via a Gearshack-side admin UI. The actual Type-Merge happens
 * Gearshack-side via Supabase migration — this workflow is **read-only**.
 *
 * Cloned from `brand-clustering.ts` (GEA-1083) with these key differences:
 *   - Read-only: NO Supabase writes anywhere in this lib.
 *   - Output schema: canonical_category_id (uuid), alias_category_ids (uuid[]),
 *     canonical_label, alias_labels — matched against existing categories rows.
 *   - Cost-cap: 200¢ ($2) — much lower than Brand-Dedup's 1000¢.
 *   - Confidence-Filter ≥0.7 — applied downstream in the workflow.
 *   - Hallucination-guard: clusters whose canonical_category_id is not in the
 *     input id-set are dropped + warned (T-cvm-06).
 *
 * Same Vercel AI Gateway / Gemini 2.5 Flash pattern as brand-clustering, with
 * the same JSON-extraction cascade (direct → fenced → balanced { ... }).
 */

import { z } from "zod";
import { randomUUID } from "node:crypto";
import { zodToJsonSchema } from "zod-to-json-schema";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const TypeSnapshotSchema = z.object({
  types: z.array(
    z.object({
      id: z.string().uuid(),
      name: z.string(),
      item_count: z.number(),
    }),
  ),
});

export type TypeSnapshot = z.infer<typeof TypeSnapshotSchema>;

const TypeClusterLLMSchema = z.object({
  canonical_category_id: z.string().uuid(),
  canonical_label: z.string(),
  alias_category_ids: z.array(z.string().uuid()).min(1),
  alias_labels: z.array(z.string()).min(1),
  llm_confidence: z.number().min(0).max(1),
  llm_reasoning: z.string(),
});

export const TypeClusterSchema = TypeClusterLLMSchema.extend({
  cluster_id: z.string().uuid(),
});

export type TypeClusterProposal = z.infer<typeof TypeClusterSchema>;

const LLMResponseSchema = z.object({
  clusters: z.array(TypeClusterLLMSchema).min(0),
});

// ---------------------------------------------------------------------------
// Pricing — defaults match Gemini 2.5 Flash list price (USD).
// Override with env vars TYPE_DEDUP_INPUT_PRICE_CENTS_PER_1M and
// TYPE_DEDUP_OUTPUT_PRICE_CENTS_PER_1M to recalibrate after first real run.
// ---------------------------------------------------------------------------

const DEFAULT_INPUT_PRICE_CENTS_PER_1M = 7.5; // $0.075 / 1M tokens
const DEFAULT_OUTPUT_PRICE_CENTS_PER_1M = 30; // $0.30  / 1M tokens
const TOKEN_ESTIMATE_PER_TYPE = 60;
const ESTIMATE_OUTPUT_MULTIPLIER = 3;

function inputPriceCentsPerMillion(): number {
  const fromEnv = process.env.TYPE_DEDUP_INPUT_PRICE_CENTS_PER_1M;
  return fromEnv ? parseFloat(fromEnv) : DEFAULT_INPUT_PRICE_CENTS_PER_1M;
}

function outputPriceCentsPerMillion(): number {
  const fromEnv = process.env.TYPE_DEDUP_OUTPUT_PRICE_CENTS_PER_1M;
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

const SYSTEM_PROMPT = `Du clusterst outdoor-gear ProductType-Namen (z.B. "Daypack", "Tent", "Sleeping Bag").
Aufgabe: Eingabe-Liste von Type-Namen mit ihren UUIDs und item_counts → finde NUR ECHTE DUPLIKATE (lexikalische/morphologische Varianten desselben Konzepts).

THE GOLDEN RULE — wenn unsicher, NICHT mergen:
Ein Cluster mit alias != canonical wird nur erzeugt wenn die Aliase **mit Sicherheit dasselbe Produkt-Konzept** beschreiben — nur in anderer Schreibweise (Casing, Plural, Gender, Bindestrich, Whitespace).

WAS GEMERGT WIRD (yes-cluster):
(1) Casing/Plural-Varianten: 'Daypack' / 'Daypacks' / 'daypack' → 1 Cluster, canonical = höchstes item_count
(2) Hyphen/Whitespace-Varianten: 'Sleeping Bag' / 'Sleeping-Bag' / 'sleepingbag' → 1 Cluster
(3) Gender-Varianten ALS ALIAS DER GENDER-FREIEN FORM: 'Daypack' (canonical) + 'Men's Daypack' + 'Women's Daypack' → 1 Cluster MIT gender_hint. Wenn KEINE gender-freie Form in der Input-Liste, lasse sie als separate Cluster.
(4) Übersetzungs-Varianten: 'Daypack' / 'Tagesrucksack' → 1 Cluster (vorausgesetzt es ist klar dasselbe Konzept)

WAS NIEMALS GEMERGT WIRD (no-merge):
(A) Verschiedene Konstruktion/Material: 'Down Quilt' ≠ 'Synthetic Quilt' ≠ 'Underquilt' (Daune ≠ Synthetik ≠ Hängematten-Iso)
(B) Verschiedene Brennstoff-/Energie-Typen: 'Canister Stove' ≠ 'Liquid Fuel Stove' ≠ 'Alcohol Stove' ≠ 'Solid Fuel Stove' — alle sind eigene Stove-Typen
(C) Verschiedene Brennstoffe: 'Canister Gas' ≠ 'Liquid Fuel' — physisch verschiedene Produkte
(D) Verschiedene Körperstellen: 'Base Layer Tops' ≠ 'Base Layer Bottoms' (Oberteil ≠ Unterteil)
(E) Verschiedene Wetter-/Activity-Funktionen: 'Rain Jacket' ≠ 'Insulated Jacket' ≠ 'Fleece Jacket' ≠ 'Softshell Jacket' ≠ 'Wind Jacket' — alle sind eigene Jacken-Typen mit verschiedenen Use-Cases
(F) Verschiedene Hosen-Typen: 'Rain Pants' ≠ 'Hiking Pants' ≠ 'Insulated Pants'
(G) Verschiedene Kit-Inhalte: 'Survival Kit' ≠ 'First Aid Kit' (verschiedener Inhalt + Zweck)
(H) Verschiedene Pack-Use-Cases: 'Backpacking Pack' ≠ 'Trekking Pack' ≠ 'Ultralight Pack' ≠ 'Specialty Pack' ≠ 'Daypack' — verschiedene Volume + Trip-Length-Targets
(I) Verschiedene Tent-Capacities/Seasons: '1-Person 3-Season Tent' ≠ '2-Person 3-Season Tent' ≠ '4-Season Tent' — verschiedene Use-Cases
(J) Verschiedene Cooking-Systeme: 'Integrated Cooking System' ≠ 'Stormcooker System' (verschiedene Konstruktion)
(K) Allgemein: gleiche Wort-Wurzel mit unterschiedlichem Adjektiv = NICHT dasselbe (Adjektiv-Bedeutung beachten)

WENN IN ZWEIFEL: Solo-Cluster mit confidence=1.0, reasoning='no variants detected'. Lieber 0 falsche Merges als 1 falscher.

llm_confidence-Skala (STRICT):
    1.00 = identische Schreibung (Solo-Cluster, kein Duplikat gefunden)
    0.95-0.99 = casing/plural/hyphen-only variants ('Daypack' / 'Daypacks' / 'daypack')
    0.90-0.94 = klare Gender-Variante als alias der gender-freien Form
    0.85-0.89 = klare Übersetzungs-Variante (gleiche Bedeutung, andere Sprache)
    <0.85 = unsicher → setze Solo-Cluster, KEIN Merge
    Downstream wird mit threshold ≥0.95 gefiltert — alles drunter wird gedropt.

OUTPUT-RULES:
(7) Solo-types (kein Duplicate gefunden) → eigener Cluster mit aliases=[selbst] (single-element), confidence=1.0, reasoning='no variants detected'.
(8) Output muss ALLE Input-types abdecken (jede type-id in genau einem cluster, entweder als canonical oder als alias).
(9) canonical_category_id und alias_category_ids MUESSEN aus den Input-UUIDs stammen — NICHT erfinden.

Antworte AUSSCHLIESSLICH im JSON-Format mit der vorgegebenen Struktur. Keine zusaetzlichen Felder, keine Erklaerungen ausserhalb von llm_reasoning.`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ClusterTypesOptions {
  maxCostCents: number;
  modelIdOverride?: string;
}

export interface ClusterTypesResult {
  clusters: TypeClusterProposal[];
  cost_cents_used: number;
  estimated_cost_cents: number;
  aborted_due_to_cost: boolean;
}

function resolveModelId(override?: string): `${string}/${string}` {
  const raw =
    override ?? process.env.TYPE_DEDUP_MODEL_ID ?? "google/gemini-2.5-flash";
  if (!raw.includes("/")) {
    throw new Error(
      `TYPE_DEDUP_MODEL_ID must be a "<provider>/<model>" string, got: ${raw}`,
    );
  }
  return raw as `${string}/${string}`;
}

function estimateCostCents(typeCount: number): number {
  const estInput = typeCount * TOKEN_ESTIMATE_PER_TYPE;
  const estOutput = estInput * ESTIMATE_OUTPUT_MULTIPLIER;
  return costCents(estInput, estOutput);
}

function buildUserPrompt(snapshot: TypeSnapshot): string {
  const lines = snapshot.types.map(
    (t) => `- id=${t.id} name="${t.name}" item_count=${t.item_count}`,
  );
  return `Cluster die folgenden ${snapshot.types.length} ProductType-Namen.

Output: JSON object { "clusters": [...] } mit:
  - canonical_category_id (UUID, MUSS aus Input-IDs stammen)
  - canonical_label (string, exact wie im Input)
  - alias_category_ids (UUID[], mind. 1, MUESSEN aus Input-IDs stammen)
  - alias_labels (string[], mind. 1)
  - llm_confidence (number 0..1)
  - llm_reasoning (kurze Erklaerung)

Input:
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
  const closed = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (closed && closed[1]) return closed[1].trim();
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
      `[type-clustering] LLM response was not valid JSON: ${content.slice(0, 500)}...`,
    );
  }
}

/**
 * Cluster outdoor-gear ProductType-Namen via Vercel AI Gateway (OpenAI-compatible
 * chat/completions endpoint). Same flow as brand-clustering with adapted schema:
 *
 *   1. Estimate cost (`types.length * 60 * 4 tokens`). Abort BEFORE the LLM
 *      call if estimate exceeds maxCostCents.
 *   2. POST chat completion with strict JSON output instruction.
 *   3. Parse + validate with Zod.
 *   4. Hallucination-guard: drop clusters where canonical_category_id is not in
 *      the input id-set (T-cvm-06).
 *   5. Compute actual cost from usage. If actual exceeds maxCostCents, return
 *      clusters but flag aborted_due_to_cost=true.
 */
export async function clusterProductTypes(
  snapshot: TypeSnapshot,
  opts: ClusterTypesOptions,
): Promise<ClusterTypesResult> {
  const validated = TypeSnapshotSchema.parse(snapshot);
  const typeCount = validated.types.length;
  const estimated_cost_cents = estimateCostCents(typeCount);

  if (estimated_cost_cents > opts.maxCostCents) {
    console.warn(
      `[type-clustering] PRE-CALL ABORT — estimated ${estimated_cost_cents}¢ exceeds cap ${opts.maxCostCents}¢ (types=${typeCount})`,
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
    throw new Error(
      "AI_GATEWAY_API_KEY env var is required for type-clustering",
    );
  }
  const rawBaseUrl =
    process.env.AI_GATEWAY_BASE_URL ?? "https://ai-gateway.vercel.sh/v1";
  const trimmed = rawBaseUrl.replace(/\/$/, "").replace(/\/ai$/, "");
  const endpoint = `${trimmed}/chat/completions`;

  console.log(
    `[type-clustering] calling ${modelId} via ${endpoint} — ${typeCount} types, estimated ${estimated_cost_cents}¢ (cap ${opts.maxCostCents}¢)`,
  );

  const schemaHint = JSON.stringify(zodToJsonSchema(LLMResponseSchema), null, 2);

  // Vercel AI Gateway routes to Vertex/Gemini for google/gemini-* models and
  // Vertex rejects `response_format: { type: 'json_object' }`. We rely on
  // prompt-only JSON instruction + robust parseJsonResponse() instead.
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
      `[type-clustering] gateway HTTP ${res.status}: ${errText.slice(0, 500)}`,
    );
  }

  const json = (await res.json()) as OpenAIChatResponse;
  const content = json.choices[0]?.message?.content;
  if (!content) {
    throw new Error(
      `[type-clustering] empty response from ${modelId}: ${JSON.stringify(json).slice(0, 300)}`,
    );
  }

  const parsed = parseJsonResponse(content);
  const validatedResponse = LLMResponseSchema.parse(parsed);

  const usage = json.usage ?? {};
  const inputTokens = usage.prompt_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? 0;
  const actualCost = costCents(inputTokens, outputTokens);

  // Hallucination-guard (T-cvm-06): drop clusters whose canonical_category_id
  // is not in the input id-set. Same for alias_category_ids: prune unknowns.
  const inputIdSet = new Set(validated.types.map((t) => t.id));
  const droppedClusters: string[] = [];
  const cleaned: TypeClusterProposal[] = [];
  for (const c of validatedResponse.clusters) {
    if (!inputIdSet.has(c.canonical_category_id)) {
      droppedClusters.push(
        `canonical_id=${c.canonical_category_id} label="${c.canonical_label}"`,
      );
      continue;
    }
    const filteredAliasIds: string[] = [];
    const filteredAliasLabels: string[] = [];
    for (let i = 0; i < c.alias_category_ids.length; i += 1) {
      const aid = c.alias_category_ids[i];
      if (inputIdSet.has(aid)) {
        filteredAliasIds.push(aid);
        filteredAliasLabels.push(c.alias_labels[i] ?? aid);
      }
    }
    if (filteredAliasIds.length === 0) {
      droppedClusters.push(
        `canonical_id=${c.canonical_category_id} (no valid aliases after pruning)`,
      );
      continue;
    }
    cleaned.push({
      ...c,
      alias_category_ids: filteredAliasIds,
      alias_labels: filteredAliasLabels,
      cluster_id: randomUUID(),
    });
  }
  if (droppedClusters.length > 0) {
    console.warn(
      `[type-clustering] hallucination-guard dropped ${droppedClusters.length} clusters: ${droppedClusters.slice(0, 5).join("; ")}${droppedClusters.length > 5 ? ", ..." : ""}`,
    );
  }

  const aborted_due_to_cost = actualCost > opts.maxCostCents;
  if (aborted_due_to_cost) {
    console.warn(
      `[type-clustering] POST-CALL OVERAGE — actual ${actualCost}¢ exceeds cap ${opts.maxCostCents}¢ (in=${inputTokens}, out=${outputTokens})`,
    );
  } else {
    console.log(
      `[type-clustering] OK — ${cleaned.length} clusters (after hallucination-guard), ${actualCost}¢ used (in=${inputTokens}, out=${outputTokens})`,
    );
  }

  // Soft-validate coverage: warn if not every input type appears in some cluster.
  const allClusterIds = new Set<string>();
  for (const c of cleaned) {
    allClusterIds.add(c.canonical_category_id);
    for (const aid of c.alias_category_ids) allClusterIds.add(aid);
  }
  const missing = validated.types.filter((t) => !allClusterIds.has(t.id));
  if (missing.length > 0) {
    console.warn(
      `[type-clustering] coverage warning — ${missing.length} input types not in any cluster: ${missing
        .slice(0, 5)
        .map((t) => `"${t.name}"`)
        .join(", ")}${missing.length > 5 ? ", ..." : ""}`,
    );
  }

  return {
    clusters: cleaned,
    cost_cents_used: actualCost,
    estimated_cost_cents,
    aborted_due_to_cost,
  };
}
