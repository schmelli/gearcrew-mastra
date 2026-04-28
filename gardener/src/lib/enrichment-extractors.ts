/**
 * Enrichment-Lite Extractors — Phase 09 / DATA-05 + DATA-06 (GEA-1086 + GEA-1087)
 *
 * Two pure extractors used by the enrichmentLite workflow:
 *
 *   1. extractWeightWithGemini(item)
 *      - Calls Gemini 2.5 Flash via Vercel AI Gateway with a zero-temp prompt
 *        asking for grams + confidence + reasoning from name + brand +
 *        description + product knowledge.
 *      - Returns { weight_grams, confidence, reasoning, cost_cents, ... }.
 *      - Hallucination-guard: rejects out-of-range weights (1g..50000g).
 *
 *   2. fetchOgImage(productUrl)
 *      - Fetches the page HTML (10s timeout, user-agent, gzip) and extracts
 *        the og:image meta-tag via regex (no cheerio dep — minimal footprint).
 *      - Falls back to <meta itemprop="image"> if og:image is missing.
 *      - Returns { image_url, error? }. NO Cloudinary upload — the caller
 *        stores the original manufacturer URL directly (post-launch follow-up
 *        will migrate to Cloudinary).
 *
 * Both extractors are pure (no Supabase) — caller drives writes.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Pricing — Gemini 2.5 Flash list price (USD), env-overridable.
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
// Weight extractor (Gemini Flash)
// ---------------------------------------------------------------------------

export interface WeightInputItem {
  id: string;
  name: string;
  brand: string | null;
  description: string | null;
}

const WeightLLMResponseSchema = z.object({
  weight_grams: z.number().nullable(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});

export type WeightLLMResponse = z.infer<typeof WeightLLMResponseSchema>;

export interface WeightExtractionResult {
  item_id: string;
  weight_grams: number | null;
  confidence: number;
  reasoning: string;
  cost_cents: number;
  input_tokens: number;
  output_tokens: number;
}

const WEIGHT_SYSTEM_PROMPT = `Du extrahierst das Gewicht (in Gramm) eines Outdoor-Gear-Items.

Aufgabe: Bestimme das Trockengewicht des Items aus name + brand + description + Produktwissen.

CRITICAL RULES:
(1) weight_grams MUSS in Gramm sein (z.B. "4 lbs 2 oz" → 1871). NIEMALS in oz/lbs lassen.
(2) confidence-Skala (KONSERVATIV):
    1.0   = Gewicht steht explizit im Text ("Weight: 1850g" → 1850)
    0.85-0.95 = klar bekanntes Produkt mit dokumentiertem Gewicht (Osprey Atmos AG 65 → 2190g)
    0.7-0.85  = plausibel basierend auf Kategorie + Größe, aber nicht direkt bestätigt
    <0.7  = unsicher → setze weight_grams=null
(3) Plausibilitätsbereich: 1g bis 50000g (50kg). Werte außerhalb → null + confidence=0.
(4) Wenn Item-Type unbekannt oder Gewicht nicht abschätzbar → weight_grams=null, confidence=0.
(5) reasoning kurz halten (max 200 Zeichen) — z.B. "Osprey Atmos AG 65 size M = 2190g (well-known product)".

Antworte AUSSCHLIESSLICH im JSON-Format. Keine zusaetzlichen Felder.`;

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

function buildWeightUserPrompt(item: WeightInputItem): string {
  const parts = [
    `name="${item.name}"`,
    item.brand ? `brand="${item.brand}"` : "",
    item.description
      ? `description="${item.description.slice(0, 500).replace(/"/g, "'")}"`
      : "",
  ].filter(Boolean);

  return `Extrahiere das Gewicht in Gramm fuer dieses Outdoor-Gear-Item.

Output: JSON object mit:
  - weight_grams (number | null) — Gewicht in Gramm, NIEMALS in oz/lbs
  - confidence (number 0..1) — siehe System-Prompt-Skala
  - reasoning (string, max 200 Zeichen) — kurze Begruendung

ITEM:
${parts.join("\n")}`;
}

/**
 * Extract weight in grams from a single gear_item via Gemini 2.5 Flash.
 *
 *   1. POST chat completion with strict JSON output instruction.
 *   2. Parse + validate with Zod.
 *   3. Plausibility-guard: weight_grams must be in [1, 50000] OR null.
 *   4. Compute cost from token usage.
 */
export async function extractWeightWithGemini(
  item: WeightInputItem,
): Promise<WeightExtractionResult> {
  const apiKey = process.env.AI_GATEWAY_API_KEY;
  if (!apiKey) {
    throw new Error(
      "AI_GATEWAY_API_KEY env var is required for weight enrichment",
    );
  }
  const rawBaseUrl =
    process.env.AI_GATEWAY_BASE_URL ?? "https://ai-gateway.vercel.sh/v1";
  const trimmed = rawBaseUrl.replace(/\/$/, "").replace(/\/ai$/, "");
  const endpoint = `${trimmed}/chat/completions`;

  const requestBody = {
    model: "google/gemini-2.5-flash",
    temperature: 0,
    max_tokens: 1024,
    messages: [
      {
        role: "system" as const,
        content: `${WEIGHT_SYSTEM_PROMPT}\n\nReturn JSON exactly: { "weight_grams": <number|null>, "confidence": <number>, "reasoning": <string> }`,
      },
      { role: "user" as const, content: buildWeightUserPrompt(item) },
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
      `[enrichment] gateway HTTP ${res.status}: ${errText.slice(0, 500)}`,
    );
  }

  const json = (await res.json()) as OpenAIChatResponse;
  const content = json.choices[0]?.message?.content;
  if (!content) {
    throw new Error(
      `[enrichment] empty response: ${JSON.stringify(json).slice(0, 300)}`,
    );
  }

  const parsed = parseJsonResponse(content);
  const validated = WeightLLMResponseSchema.parse(parsed);

  const usage = json.usage ?? {};
  const inputTokens = usage.prompt_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? 0;
  const actualCost = costCents(inputTokens, outputTokens);

  // Plausibility-guard: weight must be in [1, 50000] grams or null.
  let weight = validated.weight_grams;
  let confidence = validated.confidence;
  let reasoning = validated.reasoning;
  if (weight !== null && (weight < 1 || weight > 50000)) {
    reasoning = `plausibility_guard: ${weight}g out of [1, 50000] range (orig: ${reasoning.slice(0, 100)})`;
    weight = null;
    confidence = 0;
  }

  return {
    item_id: item.id,
    weight_grams: weight,
    confidence,
    reasoning,
    cost_cents: actualCost,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
  };
}

// ---------------------------------------------------------------------------
// Image extractor (og:image via simple HTML fetch)
// ---------------------------------------------------------------------------

export interface ImageFetchResult {
  image_url: string | null;
  source: "og:image" | "itemprop:image" | null;
  error?: string;
}

const HTTP_TIMEOUT_MS = 10_000;
const USER_AGENT =
  "Mozilla/5.0 (compatible; GearshackEnrichmentBot/1.0; +https://gearshack.app)";

function extractMetaContent(html: string, pattern: RegExp): string | null {
  const match = html.match(pattern);
  return match && match[1] ? match[1].trim() : null;
}

/**
 * Fetch a manufacturer/retailer product page and extract the primary
 * product image URL via og:image → itemprop=image fallback chain.
 *
 *   - 10s timeout per request (AbortController).
 *   - Sends a polite User-Agent.
 *   - HTTP errors and timeouts are returned as { image_url: null, error }.
 *   - Resolved URL is absolute (handles protocol-relative // and root-relative /).
 *
 * NO Cloudinary upload — caller stores the resolved URL directly.
 */
export async function fetchOgImage(
  productUrl: string,
): Promise<ImageFetchResult> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(productUrl);
  } catch {
    return { image_url: null, source: null, error: "invalid_url" };
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return { image_url: null, source: null, error: "non_http_protocol" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

  let html: string;
  try {
    const res = await fetch(productUrl, {
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.8",
      },
      signal: controller.signal,
      redirect: "follow",
    });

    if (!res.ok) {
      return {
        image_url: null,
        source: null,
        error: `http_${res.status}`,
      };
    }

    const ctype = res.headers.get("content-type") ?? "";
    if (!ctype.includes("text/html") && !ctype.includes("application/xhtml")) {
      return {
        image_url: null,
        source: null,
        error: `non_html_content_type: ${ctype.slice(0, 50)}`,
      };
    }

    // Cap to first 256KB — og:image is in <head>, no need to read full page.
    const reader = res.body?.getReader();
    if (!reader) {
      html = await res.text();
    } else {
      const chunks: Uint8Array[] = [];
      let total = 0;
      const MAX_BYTES = 256 * 1024;
      while (total < MAX_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.length;
      }
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
      html = new TextDecoder("utf-8", { fatal: false }).decode(
        Buffer.concat(chunks.map((c) => Buffer.from(c))),
      );
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      image_url: null,
      source: null,
      error: `fetch_failed: ${reason.slice(0, 100)}`,
    };
  } finally {
    clearTimeout(timer);
  }

  // og:image — try property="og:image" and property='og:image' and any order.
  const ogPatterns = [
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
  ];
  for (const pat of ogPatterns) {
    const found = extractMetaContent(html, pat);
    if (found) {
      const resolved = resolveUrl(found, parsedUrl);
      if (resolved)
        return { image_url: resolved, source: "og:image" };
    }
  }

  // itemprop=image fallback
  const itempropPatterns = [
    /<meta[^>]+itemprop=["']image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+itemprop=["']image["']/i,
  ];
  for (const pat of itempropPatterns) {
    const found = extractMetaContent(html, pat);
    if (found) {
      const resolved = resolveUrl(found, parsedUrl);
      if (resolved)
        return { image_url: resolved, source: "itemprop:image" };
    }
  }

  return { image_url: null, source: null, error: "no_og_image_found" };
}

function resolveUrl(raw: string, base: URL): string | null {
  if (!raw) return null;
  try {
    if (raw.startsWith("//")) return `${base.protocol}${raw}`;
    if (raw.startsWith("/")) return `${base.protocol}//${base.host}${raw}`;
    if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;
    // Relative URL
    return new URL(raw, base).toString();
  } catch {
    return null;
  }
}
