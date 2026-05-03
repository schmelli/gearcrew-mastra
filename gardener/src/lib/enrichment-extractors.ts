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
  source:
    | "og:image"
    | "itemprop:image"
    | "twitter:image"
    | "json-ld:product"
    | "firecrawl:og:image"
    | "firecrawl:twitter:image"
    | "firecrawl:json-ld:product"
    | null;
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

  // Stage 1: cheap static fetch. If the static response yields a usable image
  // tag we are done and skip the Firecrawl render entirely.
  const html = await fetchHtml(productUrl);
  if (html.ok) {
    const staticHit = extractImageFromHtml(html.body, parsedUrl);
    if (staticHit) {
      return { image_url: staticHit.url, source: staticHit.source };
    }
  }

  // Stage 2: Firecrawl fallback. Critically, this runs even when the static
  // fetch returned an HTTP error (403/429/Cloudflare/etc.) — that is exactly
  // the cohort Firecrawl is meant to rescue, since the local Firecrawl
  // container does its own request through a render context that often
  // sails past the static-fetch failure modes.
  const firecrawlHit = await tryFirecrawlImage(productUrl, parsedUrl);
  if (firecrawlHit) {
    return { image_url: firecrawlHit.url, source: firecrawlHit.source };
  }

  return {
    image_url: null,
    source: null,
    error: html.ok ? "no_og_image_found" : html.error,
  };
}

interface ExtractedImage {
  url: string;
  source:
    | "og:image"
    | "itemprop:image"
    | "twitter:image"
    | "json-ld:product";
}

/**
 * Walk an HTML string and return the first image hit from the priority chain:
 * og:image → itemprop=image → twitter:image → JSON-LD Product.
 * Caller is responsible for resolving the URL against `baseUrl`.
 */
function extractImageFromHtml(
  html: string,
  baseUrl: URL,
): ExtractedImage | null {
  const ogPatterns = [
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
  ];
  for (const pat of ogPatterns) {
    const found = extractMetaContent(html, pat);
    if (found) {
      const resolved = resolveUrl(found, baseUrl);
      if (resolved) return { url: resolved, source: "og:image" };
    }
  }

  const itempropPatterns = [
    /<meta[^>]+itemprop=["']image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+itemprop=["']image["']/i,
  ];
  for (const pat of itempropPatterns) {
    const found = extractMetaContent(html, pat);
    if (found) {
      const resolved = resolveUrl(found, baseUrl);
      if (resolved) return { url: resolved, source: "itemprop:image" };
    }
  }

  const twitterPatterns = [
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i,
    /<meta[^>]+property=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
  ];
  for (const pat of twitterPatterns) {
    const found = extractMetaContent(html, pat);
    if (found) {
      const resolved = resolveUrl(found, baseUrl);
      if (resolved) return { url: resolved, source: "twitter:image" };
    }
  }

  const jsonLdImage = extractJsonLdProductImage(html);
  if (jsonLdImage) {
    const resolved = resolveUrl(jsonLdImage, baseUrl);
    if (resolved) return { url: resolved, source: "json-ld:product" };
  }

  return null;
}

/**
 * Try the local Firecrawl service (selfhosted at http://firecrawl-api:3002).
 *
 * Returns null on any failure — including HTTP errors, missing API key, empty
 * HTML body, or Cloudflare blocks. Cost on the local instance is zero, but
 * each call still spends a render slot, so we cap waitFor at 2s.
 *
 * Source tag is prefixed with "firecrawl:" so failure-mode breakdowns make it
 * obvious which extraction layer the URL came from.
 */
async function tryFirecrawlImage(
  productUrl: string,
  baseUrl: URL,
): Promise<{
  url: string;
  source:
    | "firecrawl:og:image"
    | "firecrawl:twitter:image"
    | "firecrawl:json-ld:product";
} | null> {
  // Prefer the on-host self-hosted Firecrawl over the cloud variant — it is
  // already running on this VPS at firecrawl-api:3002 and does not bill per
  // request. Cloud is the fallback when self-hosted env vars are missing.
  const apiBase =
    process.env.FIRECRAWL_API_URL ??
    (process.env.FIRECRAWL_SELF_HOSTED_KEY
      ? "http://firecrawl-api:3002"
      : process.env.FIRECRAWL_SELF_HOSTED_URL ?? "https://api.firecrawl.dev");
  const apiKey =
    process.env.FIRECRAWL_SELF_HOSTED_KEY ?? process.env.FIRECRAWL_API_KEY;
  if (!apiKey) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);

  try {
    const res = await fetch(`${apiBase}/v1/scrape`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        url: productUrl,
        formats: ["rawHtml"],
        waitFor: 2000,
      }),
      signal: controller.signal,
    });

    if (!res.ok) return null;
    const json = (await res.json()) as {
      success?: boolean;
      data?: { rawHtml?: string };
    };
    if (!json.success) return null;
    const html = json.data?.rawHtml ?? "";
    if (html.length === 0) return null;

    const hit = extractImageFromHtml(html, baseUrl);
    if (!hit) return null;
    if (hit.source === "itemprop:image") {
      // itemprop is rarely the right product image once hydrated; treat it as
      // a weak signal and bail rather than store a low-quality result. If real
      // demand emerges we can promote it later.
      return null;
    }
    return {
      url: hit.url,
      source: `firecrawl:${hit.source}` as
        | "firecrawl:og:image"
        | "firecrawl:twitter:image"
        | "firecrawl:json-ld:product",
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Walk every <script type="application/ld+json"> block in the HTML, JSON.parse it,
 * and return the first image URL found on a Product-typed entity.
 *
 * Handles three real-world shapes:
 *   1. Single Product object: { "@type": "Product", "image": "..." }
 *   2. @graph array: { "@graph": [{ "@type": "Product", "image": ... }, ...] }
 *   3. image as array: "image": ["url1", "url2"] — pick first.
 *
 * Bad JSON in any single block is swallowed (sites occasionally ship malformed
 * LD); the next block still gets a chance.
 */
function extractJsonLdProductImage(html: string): string | null {
  const scriptRegex =
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const matches = html.matchAll(scriptRegex);

  for (const match of matches) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }

    const candidates: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    for (const c of candidates) {
      const found = pickProductImage(c);
      if (found) return found;
    }
  }
  return null;
}

function pickProductImage(node: unknown): string | null {
  if (!node || typeof node !== "object") return null;
  const obj = node as Record<string, unknown>;

  // @graph: walk children
  const graph = obj["@graph"];
  if (Array.isArray(graph)) {
    for (const child of graph) {
      const found = pickProductImage(child);
      if (found) return found;
    }
  }

  // Recognize Product type (@type can be string or array)
  const type = obj["@type"];
  const isProduct =
    type === "Product" ||
    (Array.isArray(type) && type.includes("Product"));
  if (!isProduct) return null;

  const img = obj.image;
  if (typeof img === "string" && img.length > 0) return img;
  if (Array.isArray(img)) {
    for (const i of img) {
      if (typeof i === "string" && i.length > 0) return i;
      if (i && typeof i === "object") {
        const url = (i as Record<string, unknown>).url;
        if (typeof url === "string" && url.length > 0) return url;
      }
    }
  }
  if (img && typeof img === "object") {
    const url = (img as Record<string, unknown>).url;
    if (typeof url === "string" && url.length > 0) return url;
  }
  return null;
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

// ---------------------------------------------------------------------------
// Weight extractor (HTML → grams)
// ---------------------------------------------------------------------------

export interface WeightFetchResult {
  weight_grams: number | null;
  source:
    | "json-ld:weight"
    | "json-ld:additional-property"
    | "definition-list"
    | "label-pattern"
    | "firecrawl:json-ld:weight"
    | "firecrawl:json-ld:additional-property"
    | "firecrawl:definition-list"
    | "firecrawl:label-pattern"
    | "llm:body-prose"
    | "firecrawl:llm:body-prose"
    | null;
  raw_text?: string;
  /** "deterministic" for regex/JSON-LD hits, "llm" for LLM-extracted. */
  confidence?: "deterministic" | "llm";
  error?: string;
}

export async function fetchProductWeight(
  productUrl: string,
): Promise<WeightFetchResult> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(productUrl);
  } catch {
    return { weight_grams: null, source: null, error: "invalid_url" };
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return { weight_grams: null, source: null, error: "non_http_protocol" };
  }

  const html = await fetchHtml(productUrl);
  if (html.ok) {
    const staticHit = extractWeightFromHtml(html.body);
    if (staticHit) return staticHit;
  }

  // Firecrawl runs even on static-fetch HTTP errors (403/429/Cloudflare) —
  // that is the exact cohort it is meant to rescue.
  const firecrawlHit = await tryFirecrawlWeight(productUrl);
  if (firecrawlHit) return firecrawlHit;

  // LLM stage: only the cohort that survived all deterministic layers reaches
  // this point. We extract weight-keyword-windowed snippets (capped to ~3KB
  // total) and ask Gemini Flash for a structured weight number, with a
  // hallucination guard that requires the returned source_phrase to contain
  // a weight-unit token.
  if (html.ok) {
    const snippets = extractWeightSnippetsFromHtml(html.body);
    const llm = await extractWeightWithLlm(snippets);
    if (llm) {
      return {
        weight_grams: llm.weight_grams,
        source: "llm:body-prose",
        raw_text: llm.source_phrase,
        confidence: "llm",
      };
    }
  } else {
    // Cloudflare/403 path — the only HTML we have is whatever Firecrawl saw,
    // and tryFirecrawlWeight already failed deterministically. A re-fetch
    // through Firecrawl just to feed the LLM would double the render cost
    // and rarely surface anything new; skip the LLM stage in that branch.
  }

  return {
    weight_grams: null,
    source: null,
    error: html.ok ? "no_weight_found" : html.error,
  };
}

async function fetchHtml(
  productUrl: string,
): Promise<{ ok: true; body: string } | { ok: false; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

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

    if (!res.ok) return { ok: false, error: `http_${res.status}` };
    const ctype = res.headers.get("content-type") ?? "";
    if (!ctype.includes("text/html") && !ctype.includes("application/xhtml")) {
      return {
        ok: false,
        error: `non_html_content_type: ${ctype.slice(0, 50)}`,
      };
    }

    const reader = res.body?.getReader();
    if (!reader) return { ok: true, body: await res.text() };
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
    return {
      ok: true,
      body: new TextDecoder("utf-8", { fatal: false }).decode(
        Buffer.concat(chunks.map((c) => Buffer.from(c))),
      ),
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `fetch_failed: ${reason.slice(0, 100)}` };
  } finally {
    clearTimeout(timer);
  }
}

function parseWeightToGrams(raw: string): number | null {
  const m = raw
    .replace(/,/g, ".")
    .match(/(\d+(?:\.\d+)?)\s*(g(?:rams?)?|kg|oz|lbs?|pounds?)\b/i);
  if (!m) return null;
  const value = parseFloat(m[1] ?? "0");
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = (m[2] ?? "").toLowerCase();

  let grams: number;
  if (unit.startsWith("kg")) grams = value * 1000;
  else if (unit.startsWith("g")) grams = value;
  else if (unit === "oz") grams = value * 28.3495;
  else if (unit.startsWith("lb") || unit.startsWith("pound"))
    grams = value * 453.592;
  else return null;

  const rounded = Math.round(grams);
  if (rounded < 1 || rounded > 50_000) return null;
  return rounded;
}

function extractWeightFromHtml(html: string): WeightFetchResult | null {
  const ld = extractJsonLdProductWeight(html);
  if (ld) return { ...ld, confidence: "deterministic" };

  const dlPattern =
    /<(dt|th)[^>]*>\s*(?:weight|gewicht)\s*<\/\1>\s*<(dd|td)[^>]*>\s*([^<]+?)\s*<\/\2>/gi;
  for (const match of html.matchAll(dlPattern)) {
    const text = match[3] ?? "";
    const grams = parseWeightToGrams(text);
    if (grams !== null) {
      return {
        weight_grams: grams,
        source: "definition-list",
        raw_text: text.slice(0, 50),
        confidence: "deterministic",
      };
    }
  }

  const labelPattern =
    /(^|[\s>(])(?:weight|gewicht|gross\s*weight)\s*[:=]\s*([^<\n]{1,30})/gi;
  for (const match of html.matchAll(labelPattern)) {
    const text = match[2] ?? "";
    const grams = parseWeightToGrams(text);
    if (grams !== null) {
      return {
        weight_grams: grams,
        source: "label-pattern",
        raw_text: text.slice(0, 50),
        confidence: "deterministic",
      };
    }
  }

  return null;
}

/**
 * Strip noise (script/style/nav/header/footer) and extract a list of text
 * snippets that mention a weight-related keyword, capped to keep total LLM
 * input under ~3KB. Each snippet is a 200-char window around the keyword
 * match. If no keyword matches, returns the first ~3KB of body text as a
 * fallback so the LLM still has something to work with.
 */
export function extractWeightSnippetsFromHtml(html: string): string[] {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();

  const keywordRegex =
    /\b(?:weight|gewicht|weighs|wiegt|gewichtet|peso)\b/gi;
  const snippets: string[] = [];
  const seen = new Set<string>();
  let totalLen = 0;
  const MAX_TOTAL = 3000;
  const WINDOW = 200;

  for (const match of stripped.matchAll(keywordRegex)) {
    const idx = match.index ?? 0;
    const start = Math.max(0, idx - 60);
    const end = Math.min(stripped.length, idx + WINDOW);
    const snippet = stripped.slice(start, end).trim();
    if (snippet.length === 0 || seen.has(snippet)) continue;
    seen.add(snippet);
    if (totalLen + snippet.length > MAX_TOTAL) break;
    snippets.push(snippet);
    totalLen += snippet.length;
  }

  if (snippets.length === 0) {
    return [stripped.slice(0, MAX_TOTAL)];
  }
  return snippets;
}

/**
 * Ask the AI Gateway (default Gemini 2.5 Flash, ~$0.0004/call) to extract a
 * product weight from text snippets. Returns null on any failure (no key, HTTP
 * error, malformed JSON, sanity-range violation, missing source phrase).
 *
 * Hard guardrails on output:
 *   - weight_grams must be 1..50_000
 *   - source_phrase must contain at least one weight-unit token (g/kg/oz/lb)
 *     — guards against pure hallucination
 */
export async function extractWeightWithLlm(
  snippets: string[],
): Promise<{ weight_grams: number; source_phrase: string } | null> {
  const apiKey = process.env.AI_GATEWAY_API_KEY;
  if (!apiKey) return null;
  if (snippets.length === 0) return null;

  const baseUrl =
    process.env.AI_GATEWAY_BASE_URL ?? "https://ai-gateway.vercel.sh/v1";
  // Default Haiku 4.5: ~$1/M input tokens, but 100% reliable JSON output and
  // respects max_tokens — Gemini Flash via this gateway sometimes emits
  // markdown-fenced output that gets truncated mid-string at 200 tokens.
  // Override via WEIGHT_LLM_MODEL_ID if you want to A/B another model.
  const modelId =
    process.env.WEIGHT_LLM_MODEL_ID ?? "anthropic/claude-haiku-4-5";

  const userPrompt = `Extract the product's own weight from these page excerpts. Return ONLY a JSON object: {"weight_grams": <integer 1..50000 or null>, "source_phrase": "<exact phrase containing weight, max 60 chars>"}.

Rules:
- The product's weight, NOT shipping weight, package weight, total weight with accessories, or weight a person can carry.
- Convert: kg → ×1000, lb → ×453.592, oz → ×28.3495.
- Pick the most product-canonical mention if multiple exist.
- If unclear, missing, or only descriptive ("lightweight", "ultralight"), return weight_grams: null.

Excerpts:
${snippets.map((s, i) => `[${i + 1}] ${s}`).join("\n")}`;

  interface ChatRequestBody {
    model: string;
    temperature: number;
    max_tokens: number;
    response_format?: { type: "json_object" };
    messages: Array<{ role: "system" | "user"; content: string }>;
  }
  const body: ChatRequestBody = {
    model: modelId,
    temperature: 0,
    // 200 tokens is too tight when the model wraps the response in a markdown
    // fence or emits verbose reasoning before the JSON — output gets truncated
    // mid-string and parsing fails. 500 tokens covers any plausible response
    // including ~60-char source_phrase + small JSON envelope.
    max_tokens: 500,
    messages: [
      {
        role: "system",
        content:
          'You extract product weight from web page excerpts. Output a single JSON object, no markdown fence, no array. Schema: {"weight_grams": number|null, "source_phrase": string}.',
      },
      { role: "user", content: userPrompt },
    ],
  };
  // response_format is an OpenAI-specific feature. Anthropic via the gateway
  // returns 400 invalid_request_error when this field is set; Google/Gemini
  // simply ignores it. Only enable for OpenAI provider prefix.
  if (modelId.startsWith("openai/")) {
    body.response_format = { type: "json_object" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content?.trim();
    if (!content) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fenced && fenced[1]) {
        try {
          parsed = JSON.parse(fenced[1]);
        } catch {
          return null;
        }
      } else {
        const objMatch = content.match(/\{[\s\S]*\}/);
        if (!objMatch) return null;
        try {
          parsed = JSON.parse(objMatch[0]);
        } catch {
          return null;
        }
      }
    }

    if (!parsed || typeof parsed !== "object") return null;
    // Defensive: some models (Gemini Flash via gateway in particular) wrap a
    // single result in a one-element array even when the prompt says "object".
    // Unwrap before validating.
    const root = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!root || typeof root !== "object") return null;
    const obj = root as Record<string, unknown>;
    const w = obj.weight_grams;
    const phrase = obj.source_phrase;
    if (typeof w !== "number" || !Number.isFinite(w)) return null;
    if (w < 1 || w > 50_000) return null;
    const rounded = Math.round(w);
    if (typeof phrase !== "string" || phrase.length === 0) return null;
    // Hallucination guard: phrase must contain a weight-unit token.
    if (!/\b(?:g(?:rams?)?|kg|oz|lbs?|pounds?)\b/i.test(phrase)) return null;
    return { weight_grams: rounded, source_phrase: phrase.slice(0, 60) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function extractJsonLdProductWeight(html: string): WeightFetchResult | null {
  const scriptRegex =
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(scriptRegex)) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const candidates: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    for (const c of candidates) {
      const found = pickProductWeight(c);
      if (found) return found;
    }
  }
  return null;
}

function pickProductWeight(node: unknown): WeightFetchResult | null {
  if (!node || typeof node !== "object") return null;
  const obj = node as Record<string, unknown>;

  const graph = obj["@graph"];
  if (Array.isArray(graph)) {
    for (const child of graph) {
      const found = pickProductWeight(child);
      if (found) return found;
    }
  }

  const type = obj["@type"];
  const isProduct =
    type === "Product" ||
    (Array.isArray(type) && type.includes("Product"));
  if (!isProduct) return null;

  const w = obj.weight;
  if (w && typeof w === "object") {
    const wObj = w as Record<string, unknown>;
    const value = Number(wObj.value);
    const unit = String(wObj.unitCode ?? wObj.unitText ?? "").toUpperCase();
    if (Number.isFinite(value)) {
      let grams: number | null = null;
      if (unit === "GRM" || unit === "G") grams = value;
      else if (unit === "KGM" || unit === "KG") grams = value * 1000;
      else if (unit === "ONZ" || unit === "OZ") grams = value * 28.3495;
      else if (unit === "LBR" || unit === "LB" || unit === "LBS")
        grams = value * 453.592;
      if (grams !== null) {
        const rounded = Math.round(grams);
        if (rounded >= 1 && rounded <= 50_000) {
          return {
            weight_grams: rounded,
            source: "json-ld:weight",
            raw_text: `${value} ${unit}`,
          };
        }
      }
    }
  }
  if (typeof w === "string") {
    const grams = parseWeightToGrams(w);
    if (grams !== null) {
      return {
        weight_grams: grams,
        source: "json-ld:weight",
        raw_text: w.slice(0, 50),
      };
    }
  }

  const ap = obj.additionalProperty;
  const apList = Array.isArray(ap) ? ap : ap ? [ap] : [];
  for (const entry of apList) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const name = String(e.name ?? "").toLowerCase();
    if (!/weight|gewicht/.test(name)) continue;
    const valueRaw = e.value;
    if (typeof valueRaw === "string") {
      const grams = parseWeightToGrams(valueRaw);
      if (grams !== null) {
        return {
          weight_grams: grams,
          source: "json-ld:additional-property",
          raw_text: valueRaw.slice(0, 50),
        };
      }
    } else if (typeof valueRaw === "number") {
      if (valueRaw >= 1 && valueRaw <= 50_000) {
        return {
          weight_grams: Math.round(valueRaw),
          source: "json-ld:additional-property",
          raw_text: `${valueRaw}`,
        };
      }
    }
  }

  return null;
}

async function tryFirecrawlWeight(
  productUrl: string,
): Promise<WeightFetchResult | null> {
  // Prefer the on-host self-hosted Firecrawl over the cloud variant — it is
  // already running on this VPS at firecrawl-api:3002 and does not bill per
  // request. Cloud is the fallback when self-hosted env vars are missing.
  const apiBase =
    process.env.FIRECRAWL_API_URL ??
    (process.env.FIRECRAWL_SELF_HOSTED_KEY
      ? "http://firecrawl-api:3002"
      : process.env.FIRECRAWL_SELF_HOSTED_URL ?? "https://api.firecrawl.dev");
  const apiKey =
    process.env.FIRECRAWL_SELF_HOSTED_KEY ?? process.env.FIRECRAWL_API_KEY;
  if (!apiKey) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(`${apiBase}/v1/scrape`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        url: productUrl,
        formats: ["rawHtml"],
        waitFor: 2000,
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      success?: boolean;
      data?: { rawHtml?: string };
    };
    if (!json.success) return null;
    const html = json.data?.rawHtml ?? "";
    if (html.length === 0) return null;

    const hit = extractWeightFromHtml(html);
    if (!hit) return null;
    return {
      weight_grams: hit.weight_grams,
      source: ("firecrawl:" + hit.source) as WeightFetchResult["source"],
      raw_text: hit.raw_text,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
